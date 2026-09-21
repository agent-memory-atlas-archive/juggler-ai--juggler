package provider

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strings"
	"testing"
	"time"
)

type admissionTestProvider struct {
	conversation *admissionTestConversation
}

func (p *admissionTestProvider) Name() string { return "admission-test" }
func (p *admissionTestProvider) ListModelsWithInfo(context.Context) ([]ModelInfo, error) {
	return nil, nil
}
func (p *admissionTestProvider) OpenConversation(context.Context, string) (Conversation, error) {
	return p.conversation, nil
}

type admissionTestConversation struct {
	submits     int
	callbacks   int
	submitErr   error
	result      *StreamResult
	lastRequest MessageRequest
}

func (cv *admissionTestConversation) Submit(_ context.Context, req MessageRequest, callback StructuredStreamCallback) (*StreamResult, error) {
	cv.submits++
	cv.lastRequest = req
	if cv.submitErr != nil {
		// Both, when a test sets both: a provider that fails mid-turn still
		// returns whatever usage arrived first (claudecode's finalizeTurn), and
		// admission has to decide what that half-a-turn's numbers are worth.
		return cv.result, cv.submitErr
	}
	if callback != nil {
		cv.callbacks++
		_, _ = callback(StreamChunk{Type: ContentBlockTypeText, Content: "called"})
	}
	if cv.result != nil {
		return cv.result, nil
	}
	return &StreamResult{}, nil
}
func (cv *admissionTestConversation) Subscribe(TurnSink)      {}
func (cv *admissionTestConversation) CacheTTL() time.Duration { return 0 }
func (cv *admissionTestConversation) Cancel(string)           {}
func (cv *admissionTestConversation) Close() error            { return nil }

func openAdmissionTestConversation(t *testing.T, cfg Config) (*admissionTestConversation, Conversation) {
	t.Helper()
	wrapped := &admissionTestConversation{}
	name := "admission-test-" + t.Name()
	RegisterProvider(ProviderInfo{Name: name}, func(Config) (Provider, error) {
		return &admissionTestProvider{conversation: wrapped}, nil
	})
	initialized, err := InitializeProvider(name, cfg)
	if err != nil {
		t.Fatal(err)
	}
	conversation, err := initialized.OpenConversation(context.Background(), "conversation")
	if err != nil {
		t.Fatal(err)
	}
	return wrapped, conversation
}

func TestContextCeilingResolvesFraction(t *testing.T) {
	for _, tc := range []struct {
		name     string
		window   int64
		fraction float64
		want     int64
	}{
		{"zero selects the soft default", 1000, 0, 850},
		{"one selects the hard window", 1000, 1, 1000},
		{"explicit fraction is honored", 1000, 0.5, 500},
		{"above one clamps to the window", 1000, 2, 1000},
		{"tiny window never floors to zero", 1, 0, 1},
	} {
		if got := ContextCeiling(tc.window, tc.fraction); got != tc.want {
			t.Errorf("%s: ContextCeiling(%d, %v) = %d, want %d", tc.name, tc.window, tc.fraction, got, tc.want)
		}
	}
}

// Admission advises at the soft ceiling for every provider, not only for the
// ones that would silently truncate: this is the trigger that makes compaction
// fire between the tool calls of a turn instead of after it settles.
func TestAdmissionAdvisesAtSoftCeilingBelowTheWindow(t *testing.T) {
	wrapped, conversation := openAdmissionTestConversation(t, Config{
		ModelCapabilities: ModelCapabilities{ContextWindowTokens: 10_000, MaxOutputTokens: 1_000},
	})

	// Estimated well under the window, but over 85% of it once the reserve is
	// charged: the old provider-authoritative rule dispatched this.
	req := MessageRequest{Messages: []Message{{Type: "user", Content: strings.Repeat("opaque/", 2_600)}}}
	_, err := conversation.Submit(context.Background(), req, nil)
	var advisory *ContextCompactionAdvisory
	if !errors.As(err, &advisory) {
		t.Fatalf("error = %T %v, want ContextCompactionAdvisory", err, err)
	}
	if advisory.EstimatedInputTokens+advisory.OutputReserveTokens > advisory.ContextWindowTokens {
		t.Fatalf("advisory = %+v, want a soft ceiling hit that still fits the hard window", advisory)
	}
	if wrapped.submits != 0 {
		t.Fatalf("provider submits = %d, want advisory before dispatch", wrapped.submits)
	}

	// The advisory asks the caller to reduce; a caller that cannot reduce says so
	// and the request goes out, which is safe because the ceiling is soft.
	req.BypassContextGuard = true
	if _, err := conversation.Submit(context.Background(), req, nil); err != nil {
		t.Fatalf("fallback bypass rejected: %v", err)
	}
	if wrapped.submits != 1 || !wrapped.lastRequest.BypassContextGuard {
		t.Fatalf("provider submit = (%d, bypass=%v), want one explicit fallback", wrapped.submits, wrapped.lastRequest.BypassContextGuard)
	}
}

func TestAdmissionDispatchesBelowTheSoftCeiling(t *testing.T) {
	wrapped, conversation := openAdmissionTestConversation(t, Config{
		ModelCapabilities: ModelCapabilities{ContextWindowTokens: 1000, MaxOutputTokens: 100},
	})
	req := MessageRequest{Messages: []Message{{Type: "user", Content: strings.Repeat("opaque/", 40)}}}
	if _, err := conversation.Submit(context.Background(), req, nil); err != nil {
		t.Fatalf("request under the ceiling was advised or rejected: %v", err)
	}
	if wrapped.submits != 1 {
		t.Fatalf("provider submits = %d, want direct dispatch", wrapped.submits)
	}
}

// A caller that has disabled automatic compaction asks for the hard window, so
// admission stops advising and lets the conversation run to the real wall.
func TestAdmissionHardCeilingFractionOnlyAdvisesAtTheWindow(t *testing.T) {
	wrapped, conversation := openAdmissionTestConversation(t, Config{
		ModelCapabilities: ModelCapabilities{ContextWindowTokens: 1000, MaxOutputTokens: 100},
	})
	req := MessageRequest{
		Messages:               []Message{{Type: "user", Content: strings.Repeat("opaque/", 110)}},
		ContextCeilingFraction: 1,
	}
	if _, err := conversation.Submit(context.Background(), req, nil); err != nil {
		t.Fatalf("request under the hard window was advised: %v", err)
	}
	if wrapped.submits != 1 {
		t.Fatalf("provider submits = %d, want direct dispatch", wrapped.submits)
	}

	req.Messages = []Message{{Type: "user", Content: strings.Repeat("opaque/", 400)}}
	_, err := conversation.Submit(context.Background(), req, nil)
	var advisory *ContextCompactionAdvisory
	if !errors.As(err, &advisory) {
		t.Fatalf("error = %T %v, want ContextCompactionAdvisory at the hard window", err, err)
	}
}

func TestAdmissionConvertsProviderContextOverflowToLimitError(t *testing.T) {
	// F2: a request that passes admission's estimate but is then rejected by the
	// provider for context overflow (an estimate under-count, or a serving window
	// we do not model) must surface a ContextLimitExceededError so the worker can
	// fold history and retry — never an unrecoverable generic error.
	wrapped, conversation := openAdmissionTestConversation(t, Config{
		ModelCapabilities: ModelCapabilities{ContextWindowTokens: 100_000, MaxOutputTokens: 4_000},
	})
	wrapped.submitErr = errors.New("Error code: 400 - input length and max_tokens exceed context limit: this model's maximum context length is 200000 tokens")
	_, err := conversation.Submit(context.Background(), MessageRequest{Messages: []Message{{Type: "user", Content: "hi"}}}, nil)
	var exceeded *ContextLimitExceededError
	if !errors.As(err, &exceeded) {
		t.Fatalf("error = %T %v, want ContextLimitExceededError", err, err)
	}
	if exceeded.Cause == nil {
		t.Fatal("converted context error has nil provider cause")
	}
	if exceeded.ContextWindowTokens != 100_000 {
		t.Fatalf("window = %d, want the model's known window 100000", exceeded.ContextWindowTokens)
	}
	if exceeded.OutputReserveTokens != 4_000 {
		t.Fatalf("reserve = %d, want the model's output reserve 4000", exceeded.OutputReserveTokens)
	}
	if wrapped.submits != 1 {
		t.Fatalf("provider submits = %d, want 1", wrapped.submits)
	}
}

func TestAdmissionLeavesUnrelatedProviderErrorsUnchanged(t *testing.T) {
	// A provider error that is not a context-overflow signal must pass through
	// verbatim so its normal (e.g. rate-limit) classification still applies.
	wrapped, conversation := openAdmissionTestConversation(t, Config{
		ModelCapabilities: ModelCapabilities{ContextWindowTokens: 100_000, MaxOutputTokens: 4_000},
	})
	sentinel := errors.New("Error code: 429 - rate limit exceeded, please retry")
	wrapped.submitErr = sentinel
	_, err := conversation.Submit(context.Background(), MessageRequest{Messages: []Message{{Type: "user", Content: "hi"}}}, nil)
	if !errors.Is(err, sentinel) {
		t.Fatalf("error = %v, want the provider error passed through unchanged", err)
	}
	var exceeded *ContextLimitExceededError
	if errors.As(err, &exceeded) {
		t.Fatal("unrelated provider error was misconverted to ContextLimitExceededError")
	}
}

func TestAdmissionDoesNotConvertTPMRateLimit(t *testing.T) {
	// F3: OpenAI's TPM 429 reads "Request too large for ... tokens per min (TPM)",
	// which contains the "request too large" overflow signature. It is a
	// retryable rate limit, not a context overflow, and must pass through
	// unchanged so the worker's rate-limit path retries it.
	wrapped, conversation := openAdmissionTestConversation(t, Config{
		ModelCapabilities: ModelCapabilities{ContextWindowTokens: 100_000, MaxOutputTokens: 4_000},
	})
	sentinel := errors.New("Error code: 429 - Request too large for gpt-4o in organization on tokens per min (TPM): Limit 30000")
	wrapped.submitErr = sentinel
	_, err := conversation.Submit(context.Background(), MessageRequest{Messages: []Message{{Type: "user", Content: "hi"}}}, nil)
	if !errors.Is(err, sentinel) {
		t.Fatalf("error = %v, want the TPM rate-limit error passed through unchanged", err)
	}
	var exceeded *ContextLimitExceededError
	if errors.As(err, &exceeded) {
		t.Fatal("TPM rate limit was misconverted to ContextLimitExceededError")
	}
	if isProviderContextOverflowError(sentinel) {
		t.Fatal("isProviderContextOverflowError classified a TPM rate limit as overflow")
	}
}

func TestAdmissionContextLimitUnwrapsProviderCause(t *testing.T) {
	// F3: a genuine context-overflow rejection converts to a
	// ContextLimitExceededError whose chain still carries the provider's own
	// wording, so the terminal error item and logs can surface it.
	wrapped, conversation := openAdmissionTestConversation(t, Config{
		ModelCapabilities: ModelCapabilities{ContextWindowTokens: 100_000, MaxOutputTokens: 4_000},
	})
	sentinel := errors.New("Error code: 400 - prompt is too long: 210000 tokens > 200000 maximum")
	wrapped.submitErr = sentinel
	_, err := conversation.Submit(context.Background(), MessageRequest{Messages: []Message{{Type: "user", Content: "hi"}}}, nil)
	var exceeded *ContextLimitExceededError
	if !errors.As(err, &exceeded) {
		t.Fatalf("error = %T %v, want ContextLimitExceededError", err, err)
	}
	if !errors.Is(err, sentinel) {
		t.Fatal("converted error does not unwrap to the original provider error")
	}
	if exceeded.Cause != sentinel {
		t.Fatalf("Cause = %v, want the original provider error", exceeded.Cause)
	}
}

func TestIsProviderContextOverflowErrorRealWorldWordings(t *testing.T) {
	// The F2 backstop is a substring match over heterogeneous provider wording:
	// a context-overflow 400 that slips through here never reaches recovery and
	// the turn dies as a generic error. Pin one real observed wording per
	// provider so signature drift is caught by a failing line, not an incident.
	overflow := []struct{ name, wording string }{
		{"openai code", `Error code: 400 - {"error":{"code":"context_length_exceeded"}}`},
		{"openai prose", "This model's maximum context length is 128000 tokens. However, your messages resulted in 131065 tokens. Please reduce the length of the messages."},
		{"openai responses", "Your input exceeds the context window of this model."},
		{"anthropic long prompt", "prompt is too long: 210522 tokens > 200000 maximum"},
		{"anthropic max_tokens", "input length and max_tokens exceed context limit: 195726 + 8192 > 200000"},
		{"deepseek", "This model's maximum context length is 131072 tokens. However, you requested 143220 tokens."},
		{"gemini", "The input token count (1189051) exceeds the maximum number of tokens allowed (1048575)."},
		{"xai", "This model's maximum prompt length is 131072 but the request contains 148231 tokens."},
		{"moonshot", "Your request exceeded model token limit: 262144"},
		{"llamacpp", "the request exceeds the available context size, try increasing the context size"},
		{"copilot", "prompt token count of 105220 exceeds the limit of 90000"},
	}
	for _, test := range overflow {
		if !isProviderContextOverflowError(errors.New(test.wording)) {
			t.Errorf("%s: overflow wording not recognized: %q", test.name, test.wording)
		}
	}
	notOverflow := []struct{ name, wording string }{
		{"openai tpm", "Request too large for gpt-4o in organization on tokens per min (TPM): Limit 30000"},
		{"anthropic rate limit", "This request would exceed your organization's rate limit of 400000 input tokens per minute"},
		{"moonshot rate limit", "rate_limit_reached_error: your account reached max request"},
		{"generic 400", "invalid_request_error: tool_choice is not supported with thinking mode"},
		{"auth", "401 unauthorized: invalid api key"},
	}
	for _, test := range notOverflow {
		if isProviderContextOverflowError(errors.New(test.wording)) {
			t.Errorf("%s: non-overflow wording misclassified as overflow: %q", test.name, test.wording)
		}
	}
	if isProviderContextOverflowError(nil) {
		t.Error("nil error classified as overflow")
	}
	// An error that is already a ContextLimitExceededError was raised by
	// admission deliberately and must be left alone.
	if isProviderContextOverflowError(&ContextLimitExceededError{ContextWindowTokens: 100}) {
		t.Error("ContextLimitExceededError reclassified as a provider overflow")
	}
}

func TestInitializeProviderWrapsEveryStatefulConversation(t *testing.T) {
	var opened []*admissionTestConversation
	name := "admission-stateful-" + t.Name()
	RegisterProvider(ProviderInfo{Name: name}, func(Config) (Provider, error) {
		return &statefulAdmissionTestProvider{opened: &opened}, nil
	})
	initialized, err := InitializeProvider(name, Config{
		ModelCapabilities: ModelCapabilities{ContextWindowTokens: 100_000},
		BudgetContract:    BudgetContract{OutputReserveTokens: 20},
	})
	if err != nil {
		t.Fatal(err)
	}

	for _, convID := range []string{"first", "second"} {
		conversation, openErr := initialized.OpenConversation(context.Background(), convID)
		if openErr != nil {
			t.Fatal(openErr)
		}
		result, submitErr := conversation.Submit(context.Background(), MessageRequest{
			Messages: []Message{{Type: "user", Content: "stateful " + convID + " " + string(make([]byte, 200))}},
		}, nil)
		if submitErr != nil {
			t.Fatalf("%s Submit() error = %v, want dispatch", convID, submitErr)
		}
		if result == nil {
			t.Fatalf("%s Submit() returned nil result", convID)
		}
	}
	if len(opened) != 2 {
		t.Fatalf("opened conversations = %d, want 2", len(opened))
	}
	for i, conversation := range opened {
		if conversation.submits != 1 {
			t.Fatalf("underlying conversation %d submits = %d, want 1", i, conversation.submits)
		}
	}
}

type statefulAdmissionTestProvider struct {
	opened *[]*admissionTestConversation
}

func (p *statefulAdmissionTestProvider) Name() string { return "stateful-admission-test" }
func (p *statefulAdmissionTestProvider) ListModelsWithInfo(context.Context) ([]ModelInfo, error) {
	return nil, nil
}
func (p *statefulAdmissionTestProvider) OpenConversation(context.Context, string) (Conversation, error) {
	conversation := &admissionTestConversation{}
	*p.opened = append(*p.opened, conversation)
	return conversation, nil
}

// The ceiling comparison is inclusive at the boundary: an exact fit dispatches
// and one token over advises. Pinned against the hard window (fraction 1) so it
// measures the arithmetic rather than the soft ceiling's headroom.
func TestAdmissionExactFitDispatchesAndOneTokenOverAdvises(t *testing.T) {
	req := MessageRequest{
		SystemPrompt:           "system",
		Messages:               []Message{{Type: "user", Content: "hello"}},
		ContextCeilingFraction: 1,
	}
	estimated := EstimateMessageRequestTokens(req)
	const reserve int64 = 17

	wrapped, exact := openAdmissionTestConversation(t, Config{
		ModelCapabilities: ModelCapabilities{ContextWindowTokens: estimated + reserve},
		BudgetContract:    BudgetContract{OutputReserveTokens: reserve},
	})
	if _, err := exact.Submit(context.Background(), req, nil); err != nil {
		t.Fatalf("exact fit rejected: %v", err)
	}
	if wrapped.submits != 1 {
		t.Fatalf("wrapped submits = %d, want 1", wrapped.submits)
	}

	wrapped, over := openAdmissionTestConversation(t, Config{
		ModelCapabilities: ModelCapabilities{ContextWindowTokens: estimated + reserve - 1},
		BudgetContract:    BudgetContract{OutputReserveTokens: reserve},
	})
	_, err := over.Submit(context.Background(), req, nil)
	var advisory *ContextCompactionAdvisory
	if !errors.As(err, &advisory) {
		t.Fatalf("error = %T %v, want ContextCompactionAdvisory one token over", err, err)
	}
	if wrapped.submits != 0 {
		t.Fatalf("wrapped submits = %d, want advisory before dispatch", wrapped.submits)
	}

	bypassed := req
	bypassed.BypassContextGuard = true
	callbackCalls := 0
	if _, err := over.Submit(context.Background(), bypassed, func(StreamChunk) (*ToolResult, error) {
		callbackCalls++
		return nil, nil
	}); err != nil {
		t.Fatalf("bypassed one-token overflow rejected: %v", err)
	}
	if wrapped.submits != 1 || wrapped.callbacks != 1 || callbackCalls != 1 {
		t.Fatalf("dispatch path calls: submits=%d wrapped callbacks=%d callbacks=%d, want 1 each", wrapped.submits, wrapped.callbacks, callbackCalls)
	}
}

// A wild local overestimate must never be terminal: admission advises, and the
// caller that cannot reduce further bypasses and reaches the provider, whose
// usage is authoritative.
func TestAdmissionPathologicalOverestimateAdvisesThenBypassDispatches(t *testing.T) {
	const (
		window  int64 = 272_000
		reserve int64 = 16_384
	)
	dense := strings.Repeat("qZ7wK2pX9mR4vB8nJ3hF6dS1gT5yL0cM", 40)
	req := MessageRequest{
		SystemPrompt:   strings.Repeat("system guidance and constraints. ", 900),
		ConversationID: "conv_sanitized_pathological_regression",
		ThreadID:       "thread_sanitized_pathological_regression",
	}
	for i := 0; i < 238; i++ {
		req.Messages = append(req.Messages, Message{
			Type:         "user",
			Content:      dense,
			ItemID:       fmt.Sprintf("item_%03d", i),
			ProviderData: map[string]any{"synthetic": true, "sequence": i},
		})
	}
	for i := 0; i < 23; i++ {
		req.Tools = append(req.Tools, ToolDefinition{
			Name:        fmt.Sprintf("synthetic_tool_%02d", i),
			Description: strings.Repeat("sanitized deterministic tool description. ", 20),
			InputSchema: []byte(`{"type":"object","properties":{"query":{"type":"string"},"path":{"type":"string"}},"required":["query"]}`),
		})
	}
	estimate := EstimateMessageRequestTokenBreakdown(req, 920)
	if estimate.Total+reserve <= window {
		t.Fatalf("pathological estimate = %d, want above input ceiling %d", estimate.Total, window-reserve)
	}

	wrapped, conversation := openAdmissionTestConversation(t, Config{
		ModelCapabilities: ModelCapabilities{ContextWindowTokens: window, MaxOutputTokens: reserve, ProviderOverheadTokens: 920},
	})
	wrapped.result = &StreamResult{InputTokens: 105_371, OutputTokens: 321}
	_, err := conversation.Submit(context.Background(), req, nil)
	var advisory *ContextCompactionAdvisory
	if !errors.As(err, &advisory) {
		t.Fatalf("error = %T %v, want ContextCompactionAdvisory", err, err)
	}
	if wrapped.submits != 0 {
		t.Fatalf("provider submits = %d, want advisory before dispatch", wrapped.submits)
	}

	req.BypassContextGuard = true
	result, err := conversation.Submit(context.Background(), req, nil)
	if err != nil {
		t.Fatalf("pathological request rejected after bypass: %v", err)
	}
	if wrapped.submits != 1 {
		t.Fatalf("provider submits = %d, want 1", wrapped.submits)
	}
	if result.InputTokens != 105_371 || result.OutputTokens != 321 {
		t.Fatalf("provider usage = %+v, want authoritative input 105371 and output 321", result)
	}
}

func TestAdmissionAdmitsTinyDimensionImageIgnoringByteLength(t *testing.T) {
	// F1: a resolved image is charged by its pixel estimate, never its raw byte
	// length. A 1×1 image carrying a large Data blob charges the flat floor and
	// comfortably fits, so admission must dispatch it rather than hard-fail an
	// image-bearing turn on an otherwise empty context.
	req := MessageRequest{Messages: []Message{{
		Type:  "user",
		Parts: []MediaPart{{Type: "image", Width: 1, Height: 1, Data: make([]byte, 300_000)}},
	}}}
	wrapped, conversation := openAdmissionTestConversation(t, Config{
		ModelCapabilities: ModelCapabilities{ContextWindowTokens: 9_000},
		BudgetContract:    BudgetContract{OutputReserveTokens: 100},
	})
	if _, err := conversation.Submit(context.Background(), req, nil); err != nil {
		t.Fatalf("Submit() error = %v, want the image admitted", err)
	}
	if wrapped.submits != 1 {
		t.Fatalf("wrapped submits = %d, want 1", wrapped.submits)
	}
}

func TestAdmissionUnknownLimitsFailClosedUnlessExplicitlyAllowed(t *testing.T) {
	wrapped, guarded := openAdmissionTestConversation(t, Config{})
	_, err := guarded.Submit(context.Background(), MessageRequest{}, nil)
	var unknown *UnknownContextLimitError
	if !errors.As(err, &unknown) {
		t.Fatalf("error = %T %v, want UnknownContextLimitError", err, err)
	}
	if unknown.Retryable() {
		t.Fatal("unknown-limit error must be non-retryable")
	}
	if wrapped.submits != 0 {
		t.Fatalf("wrapped submits = %d, want 0", wrapped.submits)
	}

	wrapped, allowed := openAdmissionTestConversation(t, Config{
		BudgetContract: BudgetContract{AllowUnknownLimits: true},
	})
	if _, err := allowed.Submit(context.Background(), MessageRequest{}, nil); err != nil {
		t.Fatalf("explicit unknown-limit opt-in rejected: %v", err)
	}
	if wrapped.submits != 1 {
		t.Fatalf("wrapped submits = %d, want 1", wrapped.submits)
	}
}

func TestAdmissionRejectsOutputReserveAtOrAboveContextWindow(t *testing.T) {
	for _, reserve := range []int64{100, 101} {
		t.Run(fmt.Sprintf("reserve_%d", reserve), func(t *testing.T) {
			wrapped, conversation := openAdmissionTestConversation(t, Config{
				ModelCapabilities: ModelCapabilities{ContextWindowTokens: 100},
				BudgetContract:    BudgetContract{OutputReserveTokens: reserve},
			})
			_, err := conversation.Submit(context.Background(), MessageRequest{}, nil)
			var invalid *InvalidOutputReserveError
			if !errors.As(err, &invalid) {
				t.Fatalf("error = %T %v, want InvalidOutputReserveError", err, err)
			}
			if invalid.ContextWindowTokens != 100 || invalid.OutputReserveTokens != reserve {
				t.Fatalf("typed fields = %+v, want window 100 and reserve %d", invalid, reserve)
			}
			if invalid.Retryable() {
				t.Fatal("invalid reserve error must be non-retryable")
			}
			if wrapped.submits != 0 {
				t.Fatalf("wrapped submits = %d, want 0", wrapped.submits)
			}
		})
	}
}

// With no contract reserve, the model's MaxOutputTokens is charged as the
// reserve — read back off the advisory the charge produces.
func TestAdmissionUsesCapabilityOutputReserve(t *testing.T) {
	req := MessageRequest{Messages: []Message{{Type: "user", Content: "x"}}}
	estimated := EstimateMessageRequestTokens(req)
	wrapped, conversation := openAdmissionTestConversation(t, Config{
		ModelCapabilities: ModelCapabilities{
			ContextWindowTokens: estimated + 8,
			MaxOutputTokens:     9,
		},
	})
	_, err := conversation.Submit(context.Background(), req, nil)
	var advisory *ContextCompactionAdvisory
	if !errors.As(err, &advisory) {
		t.Fatalf("error = %T %v, want ContextCompactionAdvisory", err, err)
	}
	if advisory.OutputReserveTokens != 9 {
		t.Fatalf("reserve = %d, want the capability output limit 9", advisory.OutputReserveTokens)
	}
	if wrapped.submits != 0 {
		t.Fatalf("wrapped submits = %d, want advisory before dispatch", wrapped.submits)
	}
}

// TestAdmissionChargesRequestOutputCapAsReserve pins F1a: a per-request
// MaxOutputTokens lowers the charged reserve to that cap, so a call the full
// capability reserve would reject is admitted, and the reported reserve on a
// genuine overflow is the effective (smaller) value.
func TestAdmissionChargesRequestOutputCapAsReserve(t *testing.T) {
	req := MessageRequest{Messages: []Message{{Type: "user", Content: "x"}}}
	estimated := EstimateMessageRequestTokens(req)

	t.Run("request cap admits what the full reserve would reject", func(t *testing.T) {
		wrapped, conversation := openAdmissionTestConversation(t, Config{
			ModelCapabilities: ModelCapabilities{ContextWindowTokens: estimated + 50, MaxOutputTokens: 100},
		})
		capped := req
		capped.MaxOutputTokens = 30 // effective reserve 30 < 50 headroom → fits
		if _, err := conversation.Submit(context.Background(), capped, nil); err != nil {
			t.Fatalf("request-capped submit rejected: %v", err)
		}
		if wrapped.submits != 1 {
			t.Fatalf("wrapped submits = %d, want 1", wrapped.submits)
		}
	})

	t.Run("provider overflow reports the effective reserve", func(t *testing.T) {
		wrapped, conversation := openAdmissionTestConversation(t, Config{
			ModelCapabilities: ModelCapabilities{ContextWindowTokens: estimated + 100, MaxOutputTokens: 100},
		})
		wrapped.submitErr = errors.New("input exceeds the context window")
		capped := req
		capped.MaxOutputTokens = 30
		_, err := conversation.Submit(context.Background(), capped, nil)
		var exceeded *ContextLimitExceededError
		if !errors.As(err, &exceeded) {
			t.Fatalf("error = %T %v, want ContextLimitExceededError", err, err)
		}
		if exceeded.OutputReserveTokens != 30 {
			t.Fatalf("reported reserve = %d, want effective request cap 30", exceeded.OutputReserveTokens)
		}
	})
}

func TestAdmissionDerivesOutputReserveFromKnownContext(t *testing.T) {
	tests := []struct {
		name    string
		window  int64
		reserve int64
	}{
		{name: "small context", window: 100_000, reserve: 20_000},
		{name: "sub-crossover context", window: 50_000, reserve: 10_000},
		{name: "monotone flat ceiling at boundary", window: 200_000, reserve: 20_000},
		{name: "large context", window: 200_001, reserve: 20_000},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := ContextSafetyReserve(test.window); got != test.reserve {
				t.Fatalf("ContextSafetyReserve(%d) = %d, want %d", test.window, got, test.reserve)
			}
			wrapped, conversation := openAdmissionTestConversation(t, Config{
				ModelCapabilities: ModelCapabilities{ContextWindowTokens: test.window},
			})
			_, err := conversation.Submit(context.Background(), MessageRequest{}, nil)
			if err != nil {
				t.Fatalf("known context with derived reserve rejected: %v", err)
			}
			if wrapped.submits != 1 {
				t.Fatalf("wrapped submits = %d, want 1", wrapped.submits)
			}
		})
	}
}

func TestEstimateMessageRequestTokensConservativeUnicodeAndOpaqueRuns(t *testing.T) {
	tests := []struct {
		name string
		text string
		min  int64
	}{
		{name: "punctuation", text: "{}[],:/\\!@#$%^&*()", min: 18},
		{name: "hash", text: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", min: 48},
		{name: "CJK", text: "漢字仮名交じり文中文測試", min: 12},
		{name: "emoji", text: "😀🧑🏽‍💻", min: 19},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := approximateTokenCount(test.text); got < test.min {
				t.Fatalf("estimate %d below conservative minimum %d", got, test.min)
			}
		})
	}
}

func TestAdmissionIncludesProviderOverheadInAdvisoryBreakdown(t *testing.T) {
	req := MessageRequest{Messages: []Message{{Type: "user", Content: "hello"}}}
	base := EstimateMessageRequestTokens(req)
	const overhead int64 = 37
	breakdown := EstimateMessageRequestTokenBreakdown(req, overhead)
	if breakdown.ProviderOverheadTokens != overhead || breakdown.Total != base+overhead {
		t.Fatalf("breakdown = %+v, want overhead %d and total %d", breakdown, overhead, base+overhead)
	}
	_, conversation := openAdmissionTestConversation(t, Config{
		ModelCapabilities: ModelCapabilities{
			ContextWindowTokens:    base + overhead,
			ProviderOverheadTokens: overhead,
		},
		BudgetContract: BudgetContract{OutputReserveTokens: 1},
	})
	_, err := conversation.Submit(context.Background(), req, nil)
	var advisory *ContextCompactionAdvisory
	if !errors.As(err, &advisory) {
		t.Fatalf("error = %T %v, want ContextCompactionAdvisory", err, err)
	}
	if advisory.Breakdown.ProviderOverheadTokens != overhead {
		t.Fatalf("advisory breakdown = %+v, want provider overhead %d", advisory.Breakdown, overhead)
	}
	if advisory.EstimatedInputTokens != base+overhead {
		t.Fatalf("advisory estimate = %d, want %d", advisory.EstimatedInputTokens, base+overhead)
	}
}

func TestEstimateMessageRequestTokensCoversCompleteEnvelope(t *testing.T) {
	base := MessageRequest{}
	rich := MessageRequest{
		SystemPrompt:   "system",
		ConversationID: "conversation",
		ThreadID:       "thread",
		ToolChoice:     &ToolChoice{Mode: ToolChoiceTool, Name: "tool"},
		Tools: []ToolDefinition{{
			Name:        "tool",
			Description: "description",
			InputSchema: []byte(`{"type":"object","properties":{"query":{"type":"string"}}}`),
		}},
		Messages: []Message{{
			Type: "tool-use", Content: "content", ProviderData: map[string]any{"signature": "opaque"},
			ToolUseID: "id", ToolName: "tool", ToolInput: map[string]any{"query": "value"},
			IsError: true, ResultType: "action", FullResult: map[string]any{"nested": map[string]any{"value": "full"}},
			ItemID: "item", IsNew: true, IsGlobal: true, Message: "message", Stack: "stack",
			EventType: "event", Source: "source",
			Parts: []MediaPart{{Type: "image", Mime: "image/png", AssetID: "asset", Width: 1500, Height: 750}},
		}},
	}
	if got, wantMin := EstimateMessageRequestTokens(rich), EstimateMessageRequestTokens(base)+1500; got < wantMin {
		t.Fatalf("rich estimate = %d, want at least %d", got, wantMin)
	}
}

func TestEstimateImageTokensChargesPixelsAndCapsDimensionlessBytes(t *testing.T) {
	tests := []struct {
		name string
		part MediaPart
		want int
	}{
		{
			name: "known dimensions are floored at the flat estimate",
			part: MediaPart{Type: "image", Width: 1, Height: 1},
			want: int(flatImageTokenEstimate),
		},
		{
			name: "known dimensions ignore byte length (F1)",
			part: MediaPart{Type: "image", Width: 1, Height: 1, Data: make([]byte, 8_000)},
			want: int(flatImageTokenEstimate),
		},
		{
			name: "unknown dimensions retain flat fallback floor",
			part: MediaPart{Type: "image"},
			want: int(flatImageTokenEstimate),
		},
		{
			name: "dimensionless mid-size bytes charge byte length",
			part: MediaPart{Type: "image", Mime: "image/webp", Data: make([]byte, 3_000)},
			want: 3_000,
		},
		{
			name: "dimensionless large bytes are capped",
			part: MediaPart{Type: "image", Mime: "image/webp", Data: make([]byte, 32_000)},
			want: int(maxFallbackImageTokens),
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := EstimateImageTokens(test.part); got != test.want {
				t.Fatalf("EstimateImageTokens() = %d, want %d", got, test.want)
			}
		})
	}
}

func TestEstimateMessageRequestTokensChargesImagePixelsNotBytes(t *testing.T) {
	// F1: even a large Data blob must not be charged as tokens when the image's
	// dimensions are known — the pixel estimate (here the flat floor) governs.
	req := MessageRequest{Messages: []Message{{
		Type:  "user",
		Parts: []MediaPart{{Type: "image", Width: 1, Height: 1, Data: make([]byte, 300_000)}},
	}}}
	breakdown := EstimateMessageRequestTokenBreakdown(req, 0)
	if breakdown.ImageTokens != flatImageTokenEstimate {
		t.Fatalf("image tokens = %d, want flat estimate %d (bytes must not be charged)", breakdown.ImageTokens, flatImageTokenEstimate)
	}
	if breakdown.Total < breakdown.ImageTokens {
		t.Fatalf("total = %d, want at least image charge %d", breakdown.Total, breakdown.ImageTokens)
	}
}

func TestEstimateMessageRequestTokensSaturates(t *testing.T) {
	req := MessageRequest{Messages: []Message{{
		Type:  "user",
		Parts: []MediaPart{{Type: "image", Width: math.MaxInt, Height: math.MaxInt}},
	}}}
	if got := EstimateMessageRequestTokens(req); got != math.MaxInt64 {
		t.Fatalf("estimate = %d, want saturation at %d", got, int64(math.MaxInt64))
	}
}

// An image estimate above the ceiling is advisory, never terminal: the caller
// that cannot shed it bypasses and the turn still dispatches.
func TestAdmissionOversizedImageAdvisesThenBypassDispatches(t *testing.T) {
	wrapped, conversation := openAdmissionTestConversation(t, Config{
		ModelCapabilities: ModelCapabilities{ContextWindowTokens: 4_000},
		BudgetContract:    BudgetContract{OutputReserveTokens: 300},
	})
	req := MessageRequest{Messages: []Message{{
		Type:    "user",
		Content: "what is in this image?",
		Parts:   []MediaPart{{Type: "image", Mime: "image/png", Width: 8_000, Height: 6_000}},
	}}}
	breakdown := EstimateMessageRequestTokenBreakdown(req, 0)
	if want := int64(8_000*6_000) / 750; breakdown.ImageTokens != want {
		t.Fatalf("image tokens = %d, want pixel estimate %d", breakdown.ImageTokens, want)
	}
	_, err := conversation.Submit(context.Background(), req, nil)
	var advisory *ContextCompactionAdvisory
	if !errors.As(err, &advisory) {
		t.Fatalf("error = %T %v, want ContextCompactionAdvisory", err, err)
	}

	req.BypassContextGuard = true
	if _, err := conversation.Submit(context.Background(), req, nil); err != nil {
		t.Fatalf("bypassed oversized image rejected: %v", err)
	}
	if wrapped.submits != 1 {
		t.Fatalf("submits = %d, want provider dispatch", wrapped.submits)
	}
}
