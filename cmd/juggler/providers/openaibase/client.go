//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaibase

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"juggler/cmd/juggler/providers/provider"
	"juggler/cmd/juggler/providers/utils"
	"juggler/internal/httpx"
	"juggler/internal/jlog"

	"github.com/openai/openai-go/v3"
	"github.com/openai/openai-go/v3/option"
	"github.com/openai/openai-go/v3/packages/respjson"
	"github.com/openai/openai-go/v3/responses"
	"github.com/openai/openai-go/v3/shared"
)

// extraStringField pulls a string value out of an SDK ExtraFields map — the
// catch-all for JSON keys the typed struct doesn't model. Reasoning models on
// the Chat Completions wire stream chain-of-thought under the non-standard
// `reasoning_content` key, which lands here. Returns "" when the field is
// absent, null, or not a JSON string.
func extraStringField(extra map[string]respjson.Field, key string) string {
	// Note: Field.Valid() reports false for ExtraFields entries (the SDK only
	// marks modeled fields valid), so gate on the raw JSON instead.
	raw := extra[key].Raw()
	if raw == "" || raw == respjson.Null {
		return ""
	}
	var s string
	if err := json.Unmarshal([]byte(raw), &s); err != nil {
		return ""
	}
	return s
}

// reasoningDeltaKeys are the non-standard Chat Completions delta fields under
// which OpenAI-compatible reasoning models stream chain-of-thought. GLM /
// DeepSeek-R1 use `reasoning_content`; OpenRouter relays it as `reasoning`.
// First non-empty wins (a single response uses one or the other, never both).
var reasoningDeltaKeys = []string{"reasoning_content", "reasoning"}

// extraReasoningDelta returns the reasoning text carried in a delta's
// ExtraFields under any known key, or "" if none is present.
func extraReasoningDelta(extra map[string]respjson.Field) string {
	for _, key := range reasoningDeltaKeys {
		if s := extraStringField(extra, key); s != "" {
			return s
		}
	}
	return ""
}

// Quirks isolates the per-vendor OpenAI-compatible API divergences in one
// struct. Default zero-value matches the standard OpenAI Chat Completions
// contract; each field overrides one vendor-specific wrinkle.
//
// Add new fields here ONLY for differences in the request shape sent on the
// wire — anything else (model lists, capabilities) belongs as a sibling
// model id in ListModelsWithInfo, not as a knob here.
type Quirks struct {
	// UseDeveloperRole sends the system prompt under the "developer" role
	// instead of "system" (OpenAI's newer API surface).
	UseDeveloperRole bool

	// MaxTokensParamName is the name of the output-cap parameter on the
	// wire — usually "max_tokens"; OpenAI's newer models want
	// "max_completion_tokens". Empty defaults to "max_tokens".
	MaxTokensParamName string

	// ForceResponsesAPI sends every model through Responses regardless of
	// model-id naming. Some providers expose Responses-only model catalogs
	// whose slugs do not contain "codex".
	ForceResponsesAPI bool

	// OmitResponsesMaxOutputTokens drops the `max_output_tokens` field from
	// Responses requests. The ChatGPT Codex backend
	// (chatgpt.com/backend-api/codex/responses) rejects it with 400
	// "Unsupported parameter: max_output_tokens" — the real Codex CLI never
	// sends it. The Platform Responses API accepts it, so this stays off by
	// default and is enabled only for the Codex-plan provider.
	OmitResponsesMaxOutputTokens bool

	// SessionAffinityHeader sends a stable per-conversation `session_id`
	// header on Responses requests. The ChatGPT Codex backend
	// (chatgpt.com/backend-api/codex/responses) keys its cache-affinity
	// routing on this header, NOT on prompt_cache_key: live A/B probing
	// measured a 26–40% prompt-cache miss rate on rapid consecutive requests
	// without it and 0 misses in 52 rounds with it (originator / OpenAI-Beta
	// headers had no effect).
	//
	// That number is a measurement of that one backend, not a general OpenAI
	// result, so this is deliberately off everywhere else — including the
	// first-party Platform provider talking to api.openai.com:
	//   - The Platform API's documented cache-routing control is the
	//     prompt_cache_key request field: a request is routed to a cache
	//     machine by that key, with the prompt prefix hash as the secondary
	//     key. promptCacheKey sets it on both the Responses and the Chat
	//     Completions path, so Platform traffic is already pinned by the
	//     supported mechanism and has nothing left for a header to buy.
	//   - No OpenAI-documented request header affects cache routing at all.
	//     `session_id` is absent from the Platform header contract, so there
	//     is no documented behaviour to switch on there.
	//   - The underscore in the name makes it actively risky on the
	//     OpenAI-compatible and local providers: nginx treats underscored
	//     request headers as invalid and drops them by default
	//     (underscores_in_headers off), and Envoy can be configured to
	//     reject the request outright with a 400, so an upstream sitting
	//     behind such a gateway breaks for no gain.
	// Enabled for the Codex-plan provider, whose CLI always sends it.
	SessionAffinityHeader bool

	// IncludePresencePenalty / IncludeFrequencyPenalty send the named
	// penalty params even when they would be zero. Most vendors silently
	// reject these; deepseek/zai accept them.
	IncludePresencePenalty  bool
	IncludeFrequencyPenalty bool

	// EchoReasoningContent replays a prior assistant turn's chain-of-thought
	// back to the API under the non-standard `reasoning_content` key. DeepSeek's
	// thinking mode rejects a continued turn (e.g. the request that follows a
	// tool call) with 400 "The `reasoning_content` in the thinking mode must be
	// passed back to the API" when the reasoning is missing. Most other vendors
	// have no such requirement (and OpenAI/OpenRouter would ignore it), so this
	// stays off by default and is enabled only where the API demands it.
	EchoReasoningContent bool

	// ForcedToolChoiceSupported opts this provider IN to sending a forced
	// single-tool choice (ToolChoice{Mode: tool, Name: X}) as a named
	// tool_choice on the wire. It defaults to false — i.e. forced tool choice is
	// downgraded to auto (the tool stays offered) unless a provider proves it
	// supports named forcing — because that is the fail-safe default: many
	// OpenAI-compatible upstreams reject a named tool_choice with a hard 400
	// (DeepSeek/GLM/Kimi thinking modes, arbitrary gateways behind
	// openai-compatible/OpenRouter, local llama.cpp/Ollama), which would brick
	// any flow that forces a tool. When
	// downgraded, the caller's prompt still directs the model to the tool, so
	// auto elicits the same call; a plain-text answer is handled by the caller's
	// text fallback. Only first-party OpenAI-shaped providers proven to honour
	// named forcing (openai, openaicodex, copilot) set this true; every other —
	// including any provider added later — is safe by default.
	ForcedToolChoiceSupported bool
}

// Config holds configuration for OpenAI-compatible providers
type Config struct {
	APIKey      string
	BearerToken string
	Headers     map[string]string
	Model       string
	BaseURL     string // Optional custom base URL for OpenAI-compatible APIs
	HTTPClient  option.HTTPClient
	Quirks      Quirks
	// MaxOutputTokens caps generated tokens per request. 0 falls back to
	// fallbackMaxOutputTokens. Carry the model's real limit here so reasoning
	// models aren't throttled mid-thought by a one-size cap.
	MaxOutputTokens int
}

// Client is a shared OpenAI client for OpenAI-compatible providers
type Client struct {
	client          *openai.Client
	model           string
	quirks          Quirks
	maxOutputTokens int
	// catalogMaxOutput, when set, returns the descriptor catalog's authoritative
	// per-model output ceiling as (value, true), or (_, false) when the catalog
	// does not know this model. effectiveMaxOutputTokens clamps the snapshot
	// value down to it, mirroring the anthropic wire clamp: a capability snapshot
	// can carry a derived reserve (window-only resolution) or an over-reported
	// live value above the model's real cap, which is a hard 400 on the wire.
	catalogMaxOutput func(model string) (int, bool)
	// thinkingSpec is this model's reasoning-effort support, resolved once at
	// construction from the descriptor's ThinkingSpecFn. Zero value ⇒ no
	// reasoning control (the request omits the effort param).
	thinkingSpec ThinkingSpec
	// serviceTierSpec is this model's non-standard serving classes, resolved
	// once at construction from the descriptor's ServiceTierSpecFn. Zero value ⇒
	// standard serving only (the request omits the service_tier param).
	serviceTierSpec ServiceTierSpec
	// providerName is the registry id this client serves. One Client type backs
	// every OpenAI-shaped provider (zai, deepseek, copilot, openrouter, ollama,
	// …), so provider-boundary errors — the idle-stall message above all — must
	// name the provider the user actually configured rather than "openai".
	// Register stamps it from the descriptor; direct construction (tests)
	// defaults to "openai".
	providerName string
	// limitDiscoveryDisabled stops ListModelsWithInfo believing the limits a
	// model list publishes about itself. Off by default — the server that will
	// serve the request is the best authority on what it will accept — and set
	// only for an endpoint whose reported numbers are known to be unusable.
	limitDiscoveryDisabled bool
}

// enhanceError adds helpful, human-oriented hints to common API errors. It
// prefers the typed *openai.Error fields (HTTP status, error code) and falls
// back to substring checks for signals that non-OpenAI-compatible gateways
// surface only in the raw message text.
func (c *Client) enhanceError(err error) error {
	var apiErr *openai.Error
	if errors.As(err, &apiErr) {
		switch apiErr.StatusCode {
		case http.StatusUnauthorized:
			return fmt.Errorf("%w (hint: your API key may be invalid)", err)
		case http.StatusTooManyRequests:
			return rateLimited(err, apiErr)
		}
		if apiErr.Code == "insufficient_quota" {
			return fmt.Errorf("%w (hint: your account may be out of credits)", err)
		}
	}

	// Fallback: some providers report these signals only in the message text.
	errMsg := err.Error()
	switch {
	case strings.Contains(errMsg, "401") || strings.Contains(errMsg, "Unauthorized"):
		return fmt.Errorf("%w (hint: your API key may be invalid)", err)
	case strings.Contains(errMsg, "429") || strings.Contains(errMsg, "Too Many Requests"):
		return rateLimited(err, nil)
	case strings.Contains(errMsg, "insufficient_quota") || strings.Contains(errMsg, "quota") ||
		strings.Contains(errMsg, "Insufficient balance") || strings.Contains(errMsg, "no resource package"):
		return fmt.Errorf("%w (hint: your account may be out of credits)", err)
	case strings.Contains(errMsg, "model") && strings.Contains(errMsg, "does not exist"):
		return fmt.Errorf("%w (hint: the specified model may not be available)", err)
	}

	return err
}

// rateLimited builds the typed refusal for a 429, carrying the wait the
// provider stated. Both the header and the response body are read: a throttle
// answers with `Retry-After`, while a ChatGPT-subscription usage cap states its
// reset only in the body. apiErr is nil when the 429 was recognised from the
// message text alone, in which case the text is all there is to read — the SDK
// embeds the response body in it, so the body fields are still reachable.
func rateLimited(err error, apiErr *openai.Error) error {
	var header http.Header
	body := err.Error()
	if apiErr != nil {
		if apiErr.Response != nil {
			header = apiErr.Response.Header
		}
		if raw := apiErr.RawJSON(); raw != "" {
			body = raw
		}
	}
	return &provider.RateLimitedError{
		RetryAfter: utils.ParseRateLimitHint(header, body),
		Message:    fmt.Sprintf("%s (hint: rate limit reached, please wait)", err.Error()),
		Cause:      err,
	}
}

// ModelFilterFunc is a function that filters model IDs
type ModelFilterFunc func(modelID string) bool

// PrefixModelFilter builds a filter admitting models whose (lower-cased) id
// begins with prefix, minus any ending in one of excludeSuffixes (e.g.
// "-embedding", "-vision"). Shared by the prefix-scoped OpenAI-compatible
// providers (zai, deepseek, …).
func PrefixModelFilter(prefix string, excludeSuffixes ...string) ModelFilterFunc {
	return func(modelID string) bool {
		id := strings.ToLower(modelID)
		if !strings.HasPrefix(id, prefix) {
			return false
		}
		for _, suffix := range excludeSuffixes {
			if strings.HasSuffix(id, suffix) {
				return false
			}
		}
		return true
	}
}

// ContextWindowFunc returns context window and max output tokens for a model
type ContextWindowFunc func(modelID string) (contextWindow int, maxOutputTokens int)

// ModalitiesFunc returns the input modalities a model accepts, e.g.
// ["text","image"]. Return nil for text-only models. May be nil itself, in
// which case every model is treated as text-only.
type ModalitiesFunc func(modelID string) []string

// ListModelsWithInfo returns detailed model information using custom filter and context window functions
func (c *Client) ListModelsWithInfo(ctx context.Context, filterFunc ModelFilterFunc, contextWindowFunc ContextWindowFunc, modalitiesFunc ModalitiesFunc, thinkingSpecFunc ThinkingSpecFunc, serviceTierSpecFunc ServiceTierSpecFunc, providerName string) ([]provider.ModelInfo, error) {
	// Fetch models from API
	page, err := c.client.Models.List(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to list models from %s: %w", providerName, err)
	}

	var modelInfos []provider.ModelInfo
	for _, model := range page.Data {
		// Apply custom filter
		if !filterFunc(model.ID) {
			continue
		}

		// What the endpoint says about this model outranks anything compiled
		// in, because it describes the server that will serve the request
		// rather than a vendor's documentation page. The two dimensions resolve
		// independently: plenty of servers publish a window and no output cap,
		// and the catalog is still the better answer for the half they omit.
		contextWindow, maxOutputTokens := contextWindowFunc(model.ID)
		fromAPI := false
		if !c.limitDiscoveryDisabled {
			discovered := DiscoverLimits(model.RawJSON())
			if discovered.ContextWindow > 0 {
				contextWindow = discovered.ContextWindow
				fromAPI = true
			}
			if discovered.MaxOutput > 0 {
				maxOutputTokens = discovered.MaxOutput
			}
		}
		maxOutputTokens = utils.ClampOutputToWindow(contextWindow, maxOutputTokens)

		var inputModalities []string
		if modalitiesFunc != nil {
			inputModalities = modalitiesFunc(model.ID)
		}

		var thinkingLevels []string
		var defaultThinkingLevel string
		if thinkingSpecFunc != nil {
			spec := thinkingSpecFunc(model.ID)
			thinkingLevels = spec.Options()
			defaultThinkingLevel = spec.Default
		}

		var serviceTiers []provider.ServiceTier
		var defaultServiceTier string
		if serviceTierSpecFunc != nil {
			spec := serviceTierSpecFunc(model.ID)
			serviceTiers = spec.Options()
			defaultServiceTier = spec.Default
		}

		modelInfos = append(modelInfos, provider.ModelInfo{
			ID:              model.ID,
			DisplayName:     utils.ModelDisplayName(model.ID),
			ContextWindow:   contextWindow,
			MaxOutputTokens: maxOutputTokens,
			// True only when this row carried its own window. An endpoint that
			// returns bare ids — OpenAI, DeepSeek, z.ai — leaves this false, and
			// that is what tells the UI the number was assumed, not measured.
			FromAPI:              fromAPI,
			InputModalities:      inputModalities,
			ThinkingLevels:       thinkingLevels,
			DefaultThinkingLevel: defaultThinkingLevel,
			ServiceTiers:         serviceTiers,
			DefaultServiceTier:   defaultServiceTier,
		})
	}

	return modelInfos, nil
}

// NewClient creates a new OpenAI-compatible client
func NewClient(cfg Config) (*Client, error) {
	opts := []option.RequestOption{}
	if cfg.BearerToken != "" {
		opts = append(opts, option.WithHeader("Authorization", "Bearer "+cfg.BearerToken))
	} else {
		opts = append(opts, option.WithAPIKey(cfg.APIKey))
	}
	if len(cfg.Headers) > 0 {
		keys := make([]string, 0, len(cfg.Headers))
		for key := range cfg.Headers {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			opts = append(opts, option.WithHeader(key, cfg.Headers[key]))
		}
	}

	// Add custom base URL if provided (for OpenAI-compatible APIs)
	if cfg.BaseURL != "" {
		opts = append(opts, option.WithBaseURL(cfg.BaseURL))
	}
	// Default to the proxy-aware shared client. No client-level timeout —
	// streaming inference needs long-lived connections and relies on transport
	// and context deadlines. Callers (and tests) may inject their own client.
	if cfg.HTTPClient == nil {
		cfg.HTTPClient = httpx.Client(0)
	}
	opts = append(opts, option.WithHTTPClient(cfg.HTTPClient))

	// Drop empty/whitespace-only SSE frames (proxy keep-alives, empty data
	// heartbeats) before the SDK's decoder json.Unmarshals them and hard-fails
	// the stream with "unexpected end of JSON input". No-op on non-SSE responses.
	opts = append(opts, option.WithMiddleware(sseEmptyFrameFilterMiddleware))

	client := openai.NewClient(opts...)

	quirks := cfg.Quirks
	if quirks.MaxTokensParamName == "" {
		quirks.MaxTokensParamName = "max_tokens"
	}

	return &Client{
		client:          &client,
		model:           cfg.Model,
		quirks:          quirks,
		maxOutputTokens: cfg.MaxOutputTokens,
		providerName:    "openai",
	}, nil
}

// NewClientFromProviderConfig creates a new OpenAI-compatible client from
// provider.Config. Validates that Model is provided (no default). A credential
// is required unless allowKeyless is set — used by gateways whose model list
// and inference need no auth, where an empty key means "send no Authorization
// header" rather than "misconfigured".
func NewClientFromProviderConfig(cfg provider.Config, baseURL string, quirks Quirks, allowKeyless bool) (*Client, error) {
	if cfg.APIKey == "" && cfg.BearerToken == "" && !allowKeyless {
		return nil, fmt.Errorf("API key or bearer token is required")
	}
	if cfg.Model == "" {
		return nil, fmt.Errorf("model is required")
	}

	return NewClient(Config{
		APIKey:          cfg.APIKey,
		BearerToken:     cfg.BearerToken,
		Headers:         cfg.Headers,
		Model:           cfg.Model,
		BaseURL:         baseURL,
		Quirks:          quirks,
		MaxOutputTokens: int(cfg.ModelCapabilities.MaxOutputTokens),
	})
}

// GPTGeneration parses the generation number out of an OpenAI `gpt-<version>`
// model id: "gpt-6-astra" → 6, "gpt-5.6-sol" → 5.6, "gpt-4o" → 4,
// "gpt-3.5-turbo" → 3.5. Anything that is not a gpt-<version> id — "o3",
// "gpt-oss-120b", "chatgpt-4o-latest", a third party's slug — returns 0.
//
// Capability questions about OpenAI's own line are asked in generations rather
// than by listing slugs, because the slugs are unknowable in advance: the
// codename after the number changes every release (sol, terra, luna, astra) and
// a list of them is a list that is out of date the day a model ships. The
// number is the part that carries the meaning.
func GPTGeneration(model string) float64 {
	rest, ok := strings.CutPrefix(strings.ToLower(model), "gpt-")
	if !ok {
		return 0
	}
	end := 0
	for end < len(rest) && (rest[end] == '.' || (rest[end] >= '0' && rest[end] <= '9')) {
		end++
	}
	version, err := strconv.ParseFloat(strings.TrimSuffix(rest[:end], "."), 64)
	if err != nil {
		return 0
	}
	return version
}

// responsesAPIGeneration is the OpenAI generation from which a tool-calling
// client must use the Responses API.
//
// Chat Completions still accepts these models, so getting this wrong does not
// look like a failure: the model answers normally and simply never calls a
// tool. What it cannot do there is combine tools with a reasoning effort, which
// is every turn Juggler sends.
const responsesAPIGeneration = 5.6

// IsResponsesAPIModel returns true if the model requires the Responses API
// instead of Chat Completions: any codex id, and any OpenAI model from
// responsesAPIGeneration onwards. Asking the question by generation is what
// lets a model released after this code shipped route correctly on the day it
// appears, rather than falling to Chat Completions until someone notices.
func IsResponsesAPIModel(model string) bool {
	if strings.Contains(strings.ToLower(model), "codex") {
		return true
	}
	return GPTGeneration(model) >= responsesAPIGeneration
}

// usesResponsesAPI reports whether this client's calls route through the
// Responses API rather than Chat Completions — either because the model id
// requires it or because the ForceResponsesAPI quirk is set.
func (c *Client) usesResponsesAPI() bool {
	return c.quirks.ForceResponsesAPI || IsResponsesAPIModel(c.model)
}

// convertToolsToResponsesAPI converts provider.ToolDefinition to Responses API tool format
func convertToolsToResponsesAPI(tools []provider.ToolDefinition) []responses.ToolUnionParam {
	if len(tools) == 0 {
		return nil
	}

	result := make([]responses.ToolUnionParam, 0, len(tools))
	for _, tool := range tools {
		// Convert input schema to FunctionParameters (map[string]any)
		var params shared.FunctionParameters
		var schemaMap map[string]any
		if err := json.Unmarshal(tool.InputSchema, &schemaMap); err == nil {
			params = shared.FunctionParameters(schemaMap)
		} else {
			jlog.Error("Failed to unmarshal input schema for tool '%s': %v", tool.Name, err)
			params = shared.FunctionParameters{}
		}

		result = append(result, responses.ToolUnionParam{
			OfFunction: &responses.FunctionToolParam{
				Name:        tool.Name,
				Description: openai.String(tool.Description),
				Parameters:  params,
			},
		})
	}
	return result
}

// transformMessagesToResponsesInput converts unified Message[] to Responses API input format
func transformMessagesToResponsesInput(messages []provider.Message) responses.ResponseNewParamsInputUnion {
	var inputItems responses.ResponseInputParam

	// Images returned by a tool ride in a following user message: a
	// function_call_output item is text-only. Accumulate and flush after each run
	// of tool results so consecutive outputs stay contiguous (see the Chat
	// Completions transform for the same ordering constraint).
	var pendingToolImages responses.ResponseInputMessageContentListParam
	flushToolImages := func() {
		if len(pendingToolImages) > 0 {
			inputItems = append(inputItems, responses.ResponseInputItemParamOfMessage(pendingToolImages, "user"))
			pendingToolImages = nil
		}
	}

	// System prompt is set separately on params; here we build input items
	// from the messages.
	for _, msg := range messages {
		role := provider.MessageTypeToRole(msg.Type)
		if role == "" && msg.Type != "provider-state" {
			continue // Skip UI-only and foreign provider-state messages
		}

		if msg.Type != "tool-result" {
			flushToolImages()
		}

		switch msg.Type {
		case "user", "context-item", "context-item-updated", "guidance", "system-reminder":
			// Skip empty user messages with no images - some APIs (e.g., Z.AI)
			// reject empty content.
			if contentList := buildResponsesUserContent(msg); len(contentList) > 0 {
				inputItems = append(inputItems, responses.ResponseInputItemParamOfMessage(contentList, "user"))
			}

		case "provider-state", "thinking":
			// New conversations carry Responses continuation state in a hidden,
			// ordered provider-state message. Thinking remains accepted for legacy
			// conversations that stored the same fields on the visible summary.
			if msg.ProviderData == nil {
				continue
			}
			itemID, _ := msg.ProviderData["reasoningItemId"].(string)
			encrypted, _ := msg.ProviderData["encryptedContent"].(string)
			if itemID == "" || encrypted == "" {
				continue
			}
			item := &responses.ResponseReasoningItemParam{
				ID:               itemID,
				EncryptedContent: openai.String(encrypted),
				Summary:          []responses.ResponseReasoningItemSummaryParam{},
			}
			if summaries, ok := msg.ProviderData["summary"].([]any); ok {
				for _, raw := range summaries {
					if summary, ok := raw.(map[string]any); ok {
						if text, _ := summary["text"].(string); text != "" {
							item.Summary = append(item.Summary, responses.ResponseReasoningItemSummaryParam{Text: text})
						}
					}
				}
			}
			if len(item.Summary) == 0 && msg.Content != "" {
				item.Summary = append(item.Summary, responses.ResponseReasoningItemSummaryParam{Text: msg.Content})
			}
			inputItems = append(inputItems, responses.ResponseInputItemUnionParam{OfReasoning: item})

		case "assistant":
			// Assistant messages use output_text type, not input_text
			inputItems = append(inputItems, responses.ResponseInputItemParamOfOutputMessage(
				[]responses.ResponseOutputMessageContentUnionParam{
					{
						OfOutputText: &responses.ResponseOutputTextParam{
							Text: msg.Content,
						},
					},
				},
				"", // ID is optional for conversation history
				responses.ResponseOutputMessageStatusCompleted,
			))

		case "tool-use":
			argsJSON, err := json.Marshal(msg.ToolInput)
			if err != nil {
				jlog.Error("Failed to marshal tool input: %v", err)
				continue
			}
			// OpenAI requires valid JSON object, not "null"
			if string(argsJSON) == "null" {
				argsJSON = []byte("{}")
			}
			// Parameter order: (arguments, callID, name)
			inputItems = append(inputItems, responses.ResponseInputItemParamOfFunctionCall(
				string(argsJSON),
				msg.ToolUseID,
				msg.ToolName,
			))

		case "tool-result":
			// Use placeholder for empty results - LLM expects a result for every tool call,
			// and some APIs (e.g., Z.AI) reject empty content
			content := msg.Content
			if isEmptyContent(content) {
				content = emptyContentPlaceholder
			}
			// Built field by field rather than via
			// ResponseInputItemParamOfFunctionCallOutput, which sets only the
			// output: a function call output without its CallID cannot be
			// matched to the call it answers.
			inputItems = append(inputItems, responses.ResponseInputItemUnionParam{
				OfFunctionCallOutput: &responses.ResponseInputItemFunctionCallOutputParam{
					CallID: openai.String(msg.ToolUseID),
					Output: responses.ResponseInputItemFunctionCallOutputOutputUnionParam{
						OfString: openai.String(content),
					},
				},
			})
			// Queue image output to follow this run of tool results as a user turn.
			for _, part := range msg.Parts {
				if uri := imageDataURI(part); uri != "" {
					pendingToolImages = append(pendingToolImages, responses.ResponseInputContentUnionParam{
						OfInputImage: &responses.ResponseInputImageParam{
							ImageURL: openai.String(uri),
							Detail:   responses.ResponseInputImageDetailAuto,
						},
					})
				}
			}
		}
	}

	flushToolImages()

	return responses.ResponseNewParamsInputUnion{
		OfInputItemList: inputItems,
	}
}

// fallbackMaxOutputTokens caps generation when the client wasn't told the
// model's real limit (Config.MaxOutputTokens == 0). A conservative
// unset-default; real per-model caps arrive in the capability snapshot.
//
// This is reached only when the model's CONTEXT WINDOW is also unknown: once a
// window resolves, the capability snapshot always carries an output limit —
// model-reported, catalogued, or the derived safety reserve filled in by the
// server — so the snapshot wins and this constant never applies. It is the
// last resort for a model nothing could be established about, not the ordinary
// cap for a local server.
const fallbackMaxOutputTokens = 8192

func (c *Client) effectiveMaxOutputTokens(req provider.MessageRequest) int {
	maxTokens := c.maxOutputTokens
	// The catalog is authoritative for the wire ceiling of a model it knows, so
	// clamp the snapshot down to it (min). Unknown models keep the snapshot. This
	// keeps admission conservative: it charged reserve = snapshot, and the wire
	// value stays at or below that.
	if c.catalogMaxOutput != nil {
		if catalogMax, known := c.catalogMaxOutput(c.model); known {
			if maxTokens <= 0 || catalogMax < maxTokens {
				maxTokens = catalogMax
			}
		}
	}
	// A per-request wire output cap (F1: hidden compaction map calls) may only
	// lower the effective max_tokens — apply it as a min() last.
	if req.MaxOutputTokens > 0 && (maxTokens <= 0 || int(req.MaxOutputTokens) < maxTokens) {
		maxTokens = int(req.MaxOutputTokens)
	}
	if maxTokens > 0 {
		return maxTokens
	}
	return fallbackMaxOutputTokens
}

// defaultResponsesInstructions is injected when ForceResponsesAPI is set and
// the system prompt is blank: those Responses-only catalogs require non-empty
// instructions on the request.
const defaultResponsesInstructions = "You are a helpful assistant."

// promptCacheKey returns a stable per-conversation/thread key for OpenAI's
// prompt-cache routing, or "" when there's no conversation id to key on.
//
// OpenAI's prefix cache lives on a specific backend shard, and requests are
// routed to a shard by hashing the prompt prefix PLUS this key when present.
// Without a stable key, consecutive turns with an identical prefix get
// load-balanced onto different shards and miss a cache that genuinely exists —
// so an agent loop's growing prefix is re-billed at the fresh rate roughly
// every other turn. Sending the same key each turn keeps the conversation
// pinned to one shard. Scoped by thread as well, mirroring how stateful
// providers keep a per-thread session (ThreadID "" = root thread).
//
// Empty conversation id => no key: a constant fallback like "/" would funnel
// unrelated conversations onto a single shard, which is worse than default
// prefix-only routing. This also means the key is absent in unit tests that
// don't set ConversationID, so request bodies there are unchanged.
func promptCacheKey(req provider.MessageRequest) string {
	if req.ConversationID == "" {
		return ""
	}
	return req.ConversationID + "/" + req.ThreadID
}

// sessionAffinityID derives a stable UUID-shaped session id from the
// conversation id, for the SessionAffinityHeader quirk. Deterministic (a
// hash, not a random UUID) so the same conversation presents the same
// session_id across turns, threads, and app restarts — a value that changed
// on restart would lose replica affinity and cold-miss the whole prefix.
// UUID-shaped because that is what the Codex CLI sends; "" (no conversation
// id) sends no header, keeping conv-less unit-test requests byte-stable.
func sessionAffinityID(convID string) string {
	if convID == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(convID))
	b := sum[:16]
	b[6] = (b[6] & 0x0f) | 0x40 // version 4 bits
	b[8] = (b[8] & 0x3f) | 0x80 // RFC 4122 variant bits
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// streamMessageResponses uses the Responses API for models that need it.
func (c *Client) streamMessageResponses(ctx context.Context, req provider.MessageRequest, callback provider.StructuredStreamCallback) (*provider.StreamResult, error) {
	jlog.Debug("Streaming message with Responses API, model %s, %d messages", c.model, len(req.Messages))

	instructions := req.SystemPrompt
	if c.quirks.ForceResponsesAPI && strings.TrimSpace(instructions) == "" {
		instructions = defaultResponsesInstructions
	}

	// Build request params - Model is a string type
	params := responses.ResponseNewParams{
		Model: c.model,
		Input: transformMessagesToResponsesInput(req.Messages),
	}
	// The ChatGPT Codex backend rejects max_output_tokens (see the quirk);
	// every other Responses endpoint honours it as the per-request output cap.
	if !c.quirks.OmitResponsesMaxOutputTokens {
		params.MaxOutputTokens = openai.Int(int64(c.effectiveMaxOutputTokens(req)))
	}
	if !c.quirks.ForceResponsesAPI {
		params.Temperature = openai.Float(1.0)
	}

	// Pin prompt-cache routing to this conversation/thread so the growing
	// prefix stays on one cache shard across turns instead of being
	// load-balanced onto a cold shard and re-billed (see promptCacheKey).
	if key := promptCacheKey(req); key != "" {
		params.PromptCacheKey = openai.String(key)
	}

	// Add system prompt as instructions
	if instructions != "" {
		params.Instructions = openai.String(instructions)
	}

	// Add tools if provided
	if len(req.Tools) > 0 {
		params.Tools = convertToolsToResponsesAPI(req.Tools)
		if tc, ok := convertToolChoiceResponses(req.ToolChoice, !c.quirks.ForcedToolChoiceSupported); ok {
			params.ToolChoice = tc
		}
	}

	// Reasoning. The advertised level list is the gate for both fields: a model
	// with no levels is not a reasoning model, and sending it a `reasoning`
	// object risks a hard 400.
	//
	// The summary is what makes reasoning visible. The Responses API streams
	// reasoning_summary_text events ONLY when a summary is asked for — with
	// effort alone the model still reasons, but emits nothing to show for it,
	// so the thinking handlers below never fire and the turn renders as a long
	// silence followed by an answer. Requested for every reasoning model, not
	// just one the user picked a level for, because the default turn (empty
	// ThinkingLevel, so no effort) is the common case.
	if len(c.thinkingSpec.Levels) > 0 {
		params.Reasoning.Summary = shared.ReasoningSummaryAuto
		// Effort is still omitted (ok=false) for an absent or unadvertised
		// level, leaving the model on its own default.
		if effort, ok := c.thinkingSpec.effortFor(req.ThinkingLevel); ok {
			params.Reasoning.Effort = openai.ReasoningEffort(effort)
		}
		// Ask for the reasoning in a form that can be handed back. These calls
		// are stateless (store=false), so the model cannot look up its own
		// earlier reasoning by id — the encrypted blob travelling back in the
		// next request's input is the only thing that carries a chain of
		// thought across a tool call.
		params.Include = append(params.Include, responses.ResponseIncludableReasoningEncryptedContent)
	}

	// Serving class. Omitted (ok=false) unless the human picked a tier this
	// model advertises, so the standard-speed request stays byte-identical. The
	// backend may serve a different tier than the one asked for without saying
	// so — sentTier is what response.completed compares against.
	sentTier, _ := c.serviceTierSpec.tierFor(req.ServiceTier)
	if sentTier != "" {
		params.ServiceTier = responses.ResponseNewParamsServiceTier(sentTier)
	}

	// Create streaming request
	opts := []option.RequestOption{}
	if c.quirks.ForceResponsesAPI {
		opts = append(opts,
			option.WithJSONSet("store", false),
			option.WithJSONSet("stream", true),
		)
	}
	// Cache-affinity routing: the backend pins consecutive requests for the
	// same session_id to the replica holding their prompt cache. See the
	// quirk's doc comment for the measured effect.
	if c.quirks.SessionAffinityHeader {
		if sid := sessionAffinityID(req.ConversationID); sid != "" {
			opts = append(opts, option.WithHeader("session_id", sid))
		}
	}
	// Provider-boundary liveness: guard the SDK stream (no read deadline of its
	// own) with an idle watchdog that cancels streamCtx if the upstream goes
	// silent. Each event resets it; see utils.StreamIdleTimeout. The session
	// also carries the running output-token estimate behind the UI spinner.
	sess, streamCtx := utils.NewStreamSession(ctx, c.providerName, callback)
	defer sess.Close()

	stream := c.client.Responses.NewStreaming(streamCtx, params, opts...)

	var inputTokens, outputTokens int
	var cachedTokens *int
	var textContent strings.Builder
	var thinkingContent strings.Builder
	type summaryKey struct {
		itemID       string
		summaryIndex int64
	}
	summaries := make(map[summaryKey]*strings.Builder)

	// emitThinking is reserved for raw Responses reasoning text. Summaries use
	// Activity snapshots below; Chat Completions reasoning remains Thinking.
	emitThinking := func(text string) error {
		if text == "" {
			return nil
		}
		thinkingContent.WriteString(text)
		sess.Progress(text)
		_, err := callback(provider.StreamChunk{
			Type:    provider.ContentBlockTypeThinking,
			Content: text,
		})
		return err
	}

	// Track function calls being assembled (keyed by item ID)
	functionCalls := make(map[string]*toolCallAccumulator)

	// Stop reason reported by a response.incomplete event, applied to a
	// text-only turn below. Empty until such an event arrives.
	var incompleteStop provider.StopReason

	// Process the stream - events are ResponseStreamEventUnion
	for stream.Next() {
		sess.Reset()
		evt := stream.Current()

		// Handle different event types using string comparison and As* methods
		switch evt.Type {
		case "response.output_item.added":
			// New output item added - check if it's a function call
			item := evt.AsResponseOutputItemAdded()
			if item.Item.Type == "function_call" {
				fc := item.Item.AsFunctionCall()
				functionCalls[item.Item.ID] = &toolCallAccumulator{
					id:   fc.CallID,
					name: fc.Name,
				}
			}

		case "response.output_text.delta":
			// Text content delta
			delta := evt.AsResponseOutputTextDelta()
			if delta.Delta != "" {
				textContent.WriteString(delta.Delta)
				sess.Progress(delta.Delta)
				streamChunk := provider.StreamChunk{
					Type:    provider.ContentBlockTypeText,
					Content: delta.Delta,
				}
				if _, err := callback(streamChunk); err != nil {
					return nil, err
				}
			}

		case "response.function_call_arguments.delta":
			// Function call arguments delta
			delta := evt.AsResponseFunctionCallArgumentsDelta()
			if fc, exists := functionCalls[delta.ItemID]; exists {
				fc.argsBuilder.WriteString(delta.Delta)
				sess.Progress(delta.Delta)
			}

		case "response.output_item.done":
			// A finished reasoning item is durable hidden continuation state. Keep
			// it ordered at the point the backend emitted it rather than attaching
			// it to a visible/transient summary.
			done := evt.AsResponseOutputItemDone()
			if done.Item.Type == "reasoning" {
				reasoning := done.Item.AsReasoning()
				if reasoning.EncryptedContent != "" && reasoning.ID != "" {
					summary := make([]any, 0, len(reasoning.Summary))
					for _, part := range reasoning.Summary {
						summary = append(summary, map[string]any{"type": "summary_text", "text": part.Text})
					}
					if _, err := callback(provider.StreamChunk{
						Type: provider.ContentBlockTypeProviderState,
						Metadata: map[string]any{
							"provider":         "openai-responses",
							"itemType":         "reasoning",
							"reasoningItemId":  reasoning.ID,
							"encryptedContent": reasoning.EncryptedContent,
							"summary":          summary,
						},
					}); err != nil {
						return nil, err
					}
				}
			}

		case "response.reasoning_summary_text.delta":
			// Summary deltas are indexed independently. Accumulate each slot and
			// emit its complete current value as a replaceable Activity snapshot.
			delta := evt.AsResponseReasoningSummaryTextDelta()
			key := summaryKey{itemID: delta.ItemID, summaryIndex: delta.SummaryIndex}
			acc := summaries[key]
			if acc == nil {
				acc = &strings.Builder{}
				summaries[key] = acc
			}
			acc.WriteString(delta.Delta)
			sess.Progress(delta.Delta)
			if _, err := callback(provider.StreamChunk{
				Type:    provider.ContentBlockTypeActivity,
				Content: acc.String(),
				Metadata: map[string]any{
					"provider":     "openai-responses",
					"kind":         "reasoning-summary",
					"itemId":       delta.ItemID,
					"outputIndex":  delta.OutputIndex,
					"summaryIndex": delta.SummaryIndex,
				},
			}); err != nil {
				return nil, err
			}

		case "response.reasoning_text.delta":
			// Raw reasoning delta (emitted by some Responses-API models in
			// place of, or alongside, the summary stream).
			if err := emitThinking(evt.AsResponseReasoningTextDelta().Delta); err != nil {
				return nil, err
			}

		case "response.completed":
			// Extract token usage from completed response. InputTokens here is
			// already the TOTAL prompt (incl. cache), per the Responses API
			// schema, so it matches the provider boundary contract directly.
			// CachedTokens is read separately as a subset.
			completed := evt.AsResponseCompleted()
			if completed.Response.Usage.InputTokens > 0 {
				inputTokens = int(completed.Response.Usage.InputTokens)
			}
			if completed.Response.Usage.OutputTokens > 0 {
				outputTokens = int(completed.Response.Usage.OutputTokens)
			}
			// Presence check, not a value check: cached usage is recorded only
			// when the backend actually sent input_tokens_details, so an
			// explicit cached_tokens:0 becomes a reported zero while an omitted
			// details block leaves CachedTokens nil (unknown).
			if completed.Response.Usage.JSON.InputTokensDetails.Valid() {
				cachedTokens = provider.Reported(int(completed.Response.Usage.InputTokensDetails.CachedTokens))
			}
			// Re-emit authoritative per-call prompt usage as a transient chunk so
			// the footer meter can anchor on it mid-turn (StreamsLiveUsage
			// providers). response.completed fires once per call.
			if inputTokens > 0 {
				if _, err := callback(provider.StreamChunk{
					Type:     provider.ContentBlockTypeUsage,
					Metadata: map[string]any{"inputTokens": inputTokens, "cachedTokens": provider.TokenCount(cachedTokens)},
				}); err != nil {
					return nil, err
				}
			}
			// The serving class the backend actually used. A tier is a request,
			// not a guarantee: the response comes back 200 with a different tier
			// and no explanation, so this echo is the only evidence the choice
			// was declined.
			if chunk, ok := c.serviceTierDowngrade(sentTier, string(completed.Response.ServiceTier)); ok {
				if _, err := callback(chunk); err != nil {
					return nil, err
				}
			}

		case "error":
			// A failure reported in-band on an otherwise-healthy 200 stream (an
			// auth rejection mid-stream, a backend fault) rather than as an HTTP
			// status. stream.Err() stays nil afterwards, so unless this becomes
			// the turn's error the turn returns zero blocks and a clean
			// end_turn — a conversation that stops with nothing to show for it.
			e := evt.AsError()
			return nil, c.enhanceError(fmt.Errorf("openai-responses stream error: %s", responsesErrorText(e.Code, e.Message, e.Param)))

		case "response.failed":
			// Terminal failure of the response itself; same silent-stop
			// reasoning as the error event above.
			failed := evt.AsResponseFailed().Response.Error
			return nil, c.enhanceError(fmt.Errorf("openai-responses response failed: %s", responsesErrorText(string(failed.Code), failed.Message, "")))

		case "response.incomplete":
			// The response stopped short (token cap, content filter). What
			// streamed so far stands, so this is a stop reason rather than an
			// error — but it must not be reported as a clean finish.
			incompleteStop = mapResponsesIncompleteReason(evt.AsResponseIncomplete().Response.IncompleteDetails.Reason)

		default:
			// Every other event is progress detail this loop has no use for
			// (response.created, *.done, content-part boundaries). Traced, never
			// dropped in silence, so a newly-meaningful event type is findable.
			jlog.Trace("[openai-responses] unhandled event %s", evt.Type)
		}
	}

	if err := stream.Err(); err != nil {
		if stall := sess.StallError(); stall != nil {
			return nil, stall
		}
		return nil, err // Don't enhance - let retry wrapper handle it
	}

	// Log the response summary
	jlog.Trace("[openai-responses RESPONSE] text=%d chars, thinking=%d chars, tools=%d, input_tokens=%d, output_tokens=%d",
		textContent.Len(), thinkingContent.Len(), len(functionCalls), inputTokens, outputTokens)

	// Stream tool_use blocks to frontend
	for _, fc := range functionCalls {
		if err := emitToolCall(fc, callback); err != nil {
			return nil, err
		}
	}

	// A truncated turn that still asked for tools stays "tool_use": the calls
	// were emitted above and the loop has to resolve them.
	stopReason := provider.StopReasonEndTurn
	switch {
	case len(functionCalls) > 0:
		stopReason = provider.StopReasonToolUse
	case incompleteStop != "":
		stopReason = incompleteStop
	}

	inputTokens, inputTokensApproximate, outputTokens := estimateMissingUsage(req, inputTokens, outputTokens, textContent.String())

	return &provider.StreamResult{
		StopReason:             stopReason,
		InputTokens:            inputTokens,
		InputTokensApproximate: inputTokensApproximate,
		OutputTokens:           outputTokens,
		CachedTokens:           cachedTokens,
		// CacheWriteTokens stays nil: the Responses API has no cache-write
		// usage field, so a write count is unknowable here — never claim 0.
	}, nil
}

// convertToolChoiceChat maps the provider-agnostic ToolChoice onto the Chat
// Completions tool_choice union. ok=false for nil/auto (the model decides). When
// downgradeForcedTool is set, a forced single tool is mapped to auto (the tool
// stays offered) for vendors whose thinking mode rejects a named tool_choice.
func convertToolChoiceChat(tc *provider.ToolChoice, downgradeForcedTool bool) (openai.ChatCompletionToolChoiceOptionUnionParam, bool) {
	if tc == nil {
		return openai.ChatCompletionToolChoiceOptionUnionParam{}, false
	}
	switch tc.Mode {
	case provider.ToolChoiceTool:
		if tc.Name == "" || downgradeForcedTool {
			return openai.ChatCompletionToolChoiceOptionUnionParam{}, false
		}
		return openai.ChatCompletionToolChoiceOptionUnionParam{
			OfFunctionToolChoice: &openai.ChatCompletionNamedToolChoiceParam{
				Function: openai.ChatCompletionNamedToolChoiceFunctionParam{Name: tc.Name},
			},
		}, true
	case provider.ToolChoiceAny:
		return openai.ChatCompletionToolChoiceOptionUnionParam{OfAuto: openai.Opt("required")}, true
	case provider.ToolChoiceNone:
		return openai.ChatCompletionToolChoiceOptionUnionParam{OfAuto: openai.Opt("none")}, true
	default: // auto / unknown
		return openai.ChatCompletionToolChoiceOptionUnionParam{}, false
	}
}

// convertToolChoiceResponses maps the provider-agnostic ToolChoice onto the
// Responses API tool_choice union. ok=false for nil/auto. When
// downgradeForcedTool is set, a forced single tool is mapped to auto (the tool
// stays offered) for providers that don't support a named tool_choice —
// mirroring the Chat Completions path so the fail-safe default holds on both wires.
func convertToolChoiceResponses(tc *provider.ToolChoice, downgradeForcedTool bool) (responses.ResponseNewParamsToolChoiceUnion, bool) {
	if tc == nil {
		return responses.ResponseNewParamsToolChoiceUnion{}, false
	}
	switch tc.Mode {
	case provider.ToolChoiceTool:
		if tc.Name == "" || downgradeForcedTool {
			return responses.ResponseNewParamsToolChoiceUnion{}, false
		}
		return responses.ResponseNewParamsToolChoiceUnion{
			OfFunctionTool: &responses.ToolChoiceFunctionParam{Name: tc.Name},
		}, true
	case provider.ToolChoiceAny:
		return responses.ResponseNewParamsToolChoiceUnion{OfToolChoiceMode: openai.Opt(responses.ToolChoiceOptionsRequired)}, true
	case provider.ToolChoiceNone:
		return responses.ResponseNewParamsToolChoiceUnion{OfToolChoiceMode: openai.Opt(responses.ToolChoiceOptionsNone)}, true
	default: // auto / unknown
		return responses.ResponseNewParamsToolChoiceUnion{}, false
	}
}

// convertToolsToOpenAI converts provider.ToolDefinition to OpenAI SDK format
func convertToolsToOpenAI(tools []provider.ToolDefinition) []openai.ChatCompletionToolUnionParam {
	if len(tools) == 0 {
		return nil
	}

	result := make([]openai.ChatCompletionToolUnionParam, 0, len(tools))
	for _, tool := range tools {
		// Convert input schema to FunctionParameters (map[string]any)
		var params shared.FunctionParameters
		var schemaMap map[string]any
		if err := json.Unmarshal(tool.InputSchema, &schemaMap); err == nil {
			params = shared.FunctionParameters(schemaMap)
		} else {
			// CRITICAL: Tool schema unmarshal failed - this will cause LLM to not use function calling properly!
			jlog.Error("Failed to unmarshal input schema for tool '%s': %v", tool.Name, err)
			jlog.Error("Raw InputSchema bytes (%d bytes): %s", len(tool.InputSchema), string(tool.InputSchema))
			jlog.Error("Tool will be sent with empty parameters, causing LLM to fall back to text-based tool syntax")
			// Fallback to empty params
			params = shared.FunctionParameters{}
		}

		// Use the helper function to create a function tool
		result = append(result, openai.ChatCompletionFunctionTool(shared.FunctionDefinitionParam{
			Name:        tool.Name,
			Description: openai.String(tool.Description),
			Parameters:  params,
		}))
	}
	return result
}

// toolCallAccumulator tracks a tool call being assembled from streaming chunks
type toolCallAccumulator struct {
	id          string
	name        string
	argsBuilder strings.Builder
}

// emitToolCall unmarshals one accumulator's streamed arguments and emits its
// tool_use stream chunk. Empty arguments are treated as an empty object so a
// no-argument tool call still emits (rather than failing JSON parsing).
func emitToolCall(acc *toolCallAccumulator, callback provider.StructuredStreamCallback) error {
	argsStr := acc.argsBuilder.String()
	if argsStr == "" {
		argsStr = "{}"
	}
	var input map[string]any
	if err := json.Unmarshal([]byte(argsStr), &input); err != nil {
		return fmt.Errorf("LLM generated invalid JSON for tool %s (id: %s): %w\nRaw args: %s", acc.name, acc.id, err, argsStr)
	}
	if _, err := callback(provider.StreamChunk{
		Type:      provider.ContentBlockTypeToolUse,
		ToolUseID: acc.id,
		ToolName:  acc.name,
		ToolInput: input,
	}); err != nil {
		return err
	}
	return nil
}

// flushToolCalls emits a tool_use stream chunk for every accumulator, in
// ascending index order. The map is keyed on the wire-side index, which OpenAI
// itself streams as contiguous {0..N-1} but other openaibase-derived
// providers may stream sparsely.
// Iterating 0..len-1 would silently drop sparse entries.
func flushToolCalls(buffers map[int]*toolCallAccumulator, callback provider.StructuredStreamCallback) error {
	indices := make([]int, 0, len(buffers))
	for idx := range buffers {
		indices = append(indices, idx)
	}
	sort.Ints(indices)

	for _, idx := range indices {
		if err := emitToolCall(buffers[idx], callback); err != nil {
			return err
		}
	}
	return nil
}

// emptyContentPlaceholder is used when tool results have empty content.
// Some APIs (e.g., Z.AI's GLM) reject messages with empty content fields.
const emptyContentPlaceholder = "(no output)"

// isEmptyContent returns true if content is empty or whitespace-only
func isEmptyContent(content string) bool {
	return strings.TrimSpace(content) == ""
}

// transformMessages converts unified Message[] to OpenAI SDK format.
// imageDataURI returns the "data:<mime>;base64,<b64>" encoding of one image
// MediaPart, or "" if the part is not a usable image (wrong type or no bytes).
// Bytes are resolved server-side into part.Data before Submit.
func imageDataURI(part provider.MediaPart) string {
	if part.Type != "image" || len(part.Data) == 0 {
		return ""
	}
	return "data:" + part.Mime + ";base64," + base64.StdEncoding.EncodeToString(part.Data)
}

// buildChatUserMessage builds the Chat Completions user message for one unified
// message. With no image parts it emits the plain string content form
// (byte-identical to the pre-image behaviour, empty content skipped); the
// content-array form is used only when images are present, in which case the
// text (if any) becomes a text part alongside one image_url part per image.
// ok=false means the message is empty (no text, no images) and must be skipped.
func buildChatUserMessage(msg provider.Message) (openai.ChatCompletionMessageParamUnion, bool) {
	var imageParts []openai.ChatCompletionContentPartUnionParam
	for _, part := range msg.Parts {
		if uri := imageDataURI(part); uri != "" {
			imageParts = append(imageParts, openai.ImageContentPart(openai.ChatCompletionContentPartImageImageURLParam{
				URL: uri,
			}))
		}
	}

	if len(imageParts) == 0 {
		// No images: preserve exact prior behaviour — plain string content,
		// empty messages skipped.
		if isEmptyContent(msg.Content) {
			return openai.ChatCompletionMessageParamUnion{}, false
		}
		return openai.UserMessage(msg.Content), true
	}

	parts := make([]openai.ChatCompletionContentPartUnionParam, 0, len(imageParts)+1)
	if !isEmptyContent(msg.Content) {
		parts = append(parts, openai.TextContentPart(msg.Content))
	}
	parts = append(parts, imageParts...)
	return openai.UserMessage(parts), true
}

// buildResponsesUserContent builds the Responses API content list for one
// unified user message: the text (if non-empty) as an input_text item plus one
// input_image item per image part. An empty list (no text, no images) signals
// the caller to skip the message, preserving the pre-image empty-skip behaviour.
func buildResponsesUserContent(msg provider.Message) responses.ResponseInputMessageContentListParam {
	var list responses.ResponseInputMessageContentListParam
	if !isEmptyContent(msg.Content) {
		list = append(list, responses.ResponseInputContentUnionParam{
			OfInputText: &responses.ResponseInputTextParam{
				Text: msg.Content,
				Type: "input_text",
			},
		})
	}
	for _, part := range msg.Parts {
		if uri := imageDataURI(part); uri != "" {
			list = append(list, responses.ResponseInputContentUnionParam{
				OfInputImage: &responses.ResponseInputImageParam{
					ImageURL: openai.String(uri),
					Detail:   responses.ResponseInputImageDetailAuto,
				},
			})
		}
	}
	return list
}

// Groups consecutive assistant messages with their tool calls.
func transformMessages(messages []provider.Message, useDeveloperRole, echoReasoning bool, systemPrompt string) []openai.ChatCompletionMessageParamUnion {
	apiMessages := make([]openai.ChatCompletionMessageParamUnion, 0, len(messages)+1)

	// Add system prompt first if provided
	if systemPrompt != "" {
		if useDeveloperRole {
			apiMessages = append(apiMessages, openai.DeveloperMessage(systemPrompt))
		} else {
			apiMessages = append(apiMessages, openai.SystemMessage(systemPrompt))
		}
	}

	// Track assistant message accumulation (text + tool calls grouped together).
	// pendingReasoning holds the turn's chain-of-thought, replayed back to the
	// API when echoReasoning is set (see Quirks.EchoReasoningContent). It is
	// reset at turn boundaries only (a user/context message, or a new thinking
	// block): a turn that produces several assistant messages on the wire (e.g.
	// delegated tool calls emitted as thread items, each a use/result pair)
	// must carry the turn's reasoning on EVERY assistant tool_use message —
	// DeepSeek rejects a tool-call assistant message without it.
	var pendingAssistantText strings.Builder
	var pendingReasoning strings.Builder
	var pendingToolCalls []openai.ChatCompletionMessageToolCallUnionParam

	flushAssistant := func() {
		if pendingAssistantText.Len() > 0 || len(pendingToolCalls) > 0 {
			assistantMsg := openai.ChatCompletionAssistantMessageParam{}
			if len(pendingToolCalls) > 0 {
				assistantMsg.ToolCalls = pendingToolCalls
			}
			if pendingAssistantText.Len() > 0 {
				assistantMsg.Content = openai.ChatCompletionAssistantMessageParamContentUnion{
					OfString: openai.String(pendingAssistantText.String()),
				}
			}
			// DeepSeek's thinking mode requires the turn's reasoning to be
			// echoed back under the non-standard `reasoning_content` key.
			if echoReasoning && pendingReasoning.Len() > 0 {
				assistantMsg.SetExtraFields(map[string]any{
					"reasoning_content": pendingReasoning.String(),
				})
			}
			apiMessages = append(apiMessages, openai.ChatCompletionMessageParamUnion{
				OfAssistant: &assistantMsg,
			})
		}
		pendingAssistantText.Reset()
		pendingToolCalls = nil
		// Note: pendingReasoning deliberately survives the flush — see the
		// reasoning comment above. It is cleared by the user/context branch
		// and replaced by the next thinking block.
	}

	// A tool-result that returned images can't ride on the role="tool" message
	// (those are text-only), so images are accumulated here and flushed as a
	// following role="user" message. Accumulating (rather than emitting inline)
	// keeps consecutive tool messages contiguous: [tool(A), tool(B), user(imgs)]
	// stays valid, whereas [tool(A), user(img), tool(B)] would not.
	var pendingToolImages []openai.ChatCompletionContentPartUnionParam
	flushToolImages := func() {
		if len(pendingToolImages) > 0 {
			apiMessages = append(apiMessages, openai.UserMessage(pendingToolImages))
			pendingToolImages = nil
		}
	}

	for _, msg := range messages {
		role := provider.MessageTypeToRole(msg.Type)
		if role == "" {
			continue // Skip UI-only messages (error, system)
		}

		// Any non-tool-result message ends a run of tool results: flush their
		// images as a user turn before this message is emitted.
		if msg.Type != "tool-result" {
			flushToolImages()
		}

		switch msg.Type {
		case "user", "context-item", "context-item-updated", "guidance", "system-reminder":
			// Flush any pending assistant content first
			flushAssistant()
			// Turn boundary: the reasoning was already replayed on the turn's
			// assistant message(s); do not leak it into the next turn.
			pendingReasoning.Reset()
			// Skip empty user messages with no images - some APIs (e.g., Z.AI)
			// reject empty content.
			if userMsg, ok := buildChatUserMessage(msg); ok {
				apiMessages = append(apiMessages, userMsg)
			}

		case "assistant":
			pendingAssistantText.WriteString(msg.Content)

		case "thinking":
			// Thinking blocks are internal model state. OpenAI has no native
			// thinking channel, so they are normally dropped — but DeepSeek's
			// thinking mode requires the reasoning be replayed on the next
			// request, so accumulate it when echoReasoning is set.
			if echoReasoning {
				// A new block starts a new turn's chain-of-thought; replace
				// any reasoning left over from the previous turn.
				pendingReasoning.Reset()
				pendingReasoning.WriteString(msg.Content)
			}

		case "tool-use":
			// Accumulate with pending assistant message
			argsJSON, err := json.Marshal(msg.ToolInput)
			if err != nil {
				jlog.Error("Failed to marshal tool input: %v", err)
				continue
			}
			// OpenAI requires valid JSON object, not "null"
			if string(argsJSON) == "null" {
				argsJSON = []byte("{}")
			}
			pendingToolCalls = append(pendingToolCalls, openai.ChatCompletionMessageToolCallUnionParam{
				OfFunction: &openai.ChatCompletionMessageFunctionToolCallParam{
					ID: msg.ToolUseID,
					Function: openai.ChatCompletionMessageFunctionToolCallFunctionParam{
						Name:      msg.ToolName,
						Arguments: string(argsJSON),
					},
				},
			})

		case "tool-result":
			// Flush pending assistant content before tool result
			flushAssistant()
			// OpenAI expects role="tool" with tool_call_id
			// Use placeholder for empty results - LLM expects a result for every tool call,
			// and some APIs (e.g., Z.AI) reject empty content
			content := msg.Content
			if isEmptyContent(content) {
				content = emptyContentPlaceholder
			}
			apiMessages = append(apiMessages, openai.ToolMessage(content, msg.ToolUseID))
			// Queue any image output to follow this run of tool messages as a
			// user turn (role="tool" can't carry images).
			for _, part := range msg.Parts {
				if uri := imageDataURI(part); uri != "" {
					pendingToolImages = append(pendingToolImages, openai.ImageContentPart(openai.ChatCompletionContentPartImageImageURLParam{
						URL: uri,
					}))
				}
			}
		}
	}

	// Flush any remaining assistant content, then any trailing tool-result images.
	flushAssistant()
	flushToolImages()

	return apiMessages
}

// streamMessage streams a message response with structured chunks.
// Makes a single API call and returns. Rate-limit retries are handled by the
// strategy loop (which can update UI state and process new messages during the wait).
// Unexported because the Conversation handle (conversation.go) is the
// public entry point; this is the per-call implementation.
func (c *Client) streamMessage(ctx context.Context, req provider.MessageRequest, callback provider.StructuredStreamCallback) (*provider.StreamResult, error) {
	var result *provider.StreamResult
	var err error

	if c.usesResponsesAPI() {
		result, err = c.streamMessageResponses(ctx, req, callback)
	} else {
		result, err = c.streamMessageChatCompletions(ctx, req, callback)
	}

	if err != nil {
		return nil, c.enhanceError(err)
	}
	return result, nil
}

// streamMessageChatCompletions streams using the Chat Completions API
func (c *Client) streamMessageChatCompletions(ctx context.Context, req provider.MessageRequest, callback provider.StructuredStreamCallback) (*provider.StreamResult, error) {
	jlog.Debug("Streaming message with model %s, %d messages", c.model, len(req.Messages))
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}

	// Transform unified Message[] to OpenAI format
	apiMessages := transformMessages(req.Messages, c.quirks.UseDeveloperRole, c.quirks.EchoReasoningContent, req.SystemPrompt)

	// Log the SDK request payload for debugging
	jlog.Trace("[openai REQUEST] model=%s, messages=%d, tools=%d", c.model, len(apiMessages), len(req.Tools))

	// Build request params
	params := openai.ChatCompletionNewParams{
		Model:       openai.ChatModel(c.model),
		Messages:    apiMessages,
		Temperature: openai.Float(1.0),
		StreamOptions: openai.ChatCompletionStreamOptionsParam{
			IncludeUsage: openai.Bool(true),
		},
	}

	// Pin prompt-cache routing to this conversation/thread so the growing
	// prefix stays on one cache shard across turns instead of being
	// load-balanced onto a cold shard and re-billed (see promptCacheKey).
	if key := promptCacheKey(req); key != "" {
		params.PromptCacheKey = openai.String(key)
	}

	if c.quirks.IncludeFrequencyPenalty {
		params.FrequencyPenalty = openai.Float(0.3)
	}

	if c.quirks.IncludePresencePenalty {
		params.PresencePenalty = openai.Float(0.3)
	}

	if len(req.Tools) > 0 {
		params.Tools = convertToolsToOpenAI(req.Tools)
		if tc, ok := convertToolChoiceChat(req.ToolChoice, !c.quirks.ForcedToolChoiceSupported); ok {
			params.ToolChoice = tc
		}
	}

	// Reasoning effort. Omitted (ok=false) for non-reasoning models and absent/
	// unsupported levels, keeping the request byte-identical to today.
	if effort, ok := c.thinkingSpec.effortFor(req.ThinkingLevel); ok {
		params.ReasoningEffort = openai.ReasoningEffort(effort)
	}

	// Honour the model's real output cap when the descriptor supplied one (the
	// same value the model list advertises); fall back to a conservative
	// default only when it's unset. Not a floor — a model that legitimately
	// caps below the default (e.g. ollama's 4096) must send its own value, or
	// ModelInfo.MaxOutputTokens would be a lie relative to the wire.
	maxTokens := c.effectiveMaxOutputTokens(req)

	// Provider-boundary liveness: guard the SDK stream (no read deadline of its
	// own) with an idle watchdog that cancels streamCtx if the upstream goes
	// silent. Each event resets it; see utils.StreamIdleTimeout. The session
	// also carries the running output-token estimate behind the UI spinner.
	sess, streamCtx := utils.NewStreamSession(ctx, c.providerName, callback)
	defer sess.Close()

	stream := c.client.Chat.Completions.NewStreaming(streamCtx, params, option.WithJSONSet(c.quirks.MaxTokensParamName, maxTokens))

	// Track tool calls being assembled (OpenAI streams them incrementally)
	toolCallBuffers := make(map[int]*toolCallAccumulator)

	var inputTokens, outputTokens, lastEmittedInput int
	var cachedTokens *int
	var lastFinishReason string
	var textContent strings.Builder
	var thinkingContent strings.Builder

	// Process the stream
	for stream.Next() {
		sess.Reset()
		chunk := stream.Current()

		if chunk.Usage.PromptTokens > 0 {
			inputTokens = int(chunk.Usage.PromptTokens)
		}
		if chunk.Usage.CompletionTokens > 0 {
			outputTokens = int(chunk.Usage.CompletionTokens)
		}
		// Presence check, not a value check: cached usage is recorded only when
		// the chunk actually carries prompt_tokens_details, so an explicit
		// cached_tokens:0 becomes a reported zero while an omitted details
		// block leaves CachedTokens nil (unknown).
		if chunk.Usage.JSON.PromptTokensDetails.Valid() {
			cachedTokens = provider.Reported(int(chunk.Usage.PromptTokensDetails.CachedTokens))
		}
		// Re-emit authoritative per-call prompt usage as a transient chunk so the
		// footer meter can anchor on it mid-turn (StreamsLiveUsage providers).
		// Chat Completions reports usage in the final chunk; guard on change so a
		// provider that repeats it across chunks emits only once.
		if inputTokens > 0 && inputTokens != lastEmittedInput {
			lastEmittedInput = inputTokens
			if _, err := callback(provider.StreamChunk{
				Type:     provider.ContentBlockTypeUsage,
				Metadata: map[string]any{"inputTokens": inputTokens, "cachedTokens": provider.TokenCount(cachedTokens)},
			}); err != nil {
				return nil, err
			}
		}

		for _, choice := range chunk.Choices {
			if choice.FinishReason != "" {
				lastFinishReason = choice.FinishReason
			}

			// Stream reasoning ("thinking") content immediately. Reasoning
			// models on the Chat Completions wire (GLM, DeepSeek-R1, OpenRouter,
			// …) carry chain-of-thought in a non-standard delta field
			// (`reasoning_content` or `reasoning`), which the SDK parks in
			// ExtraFields. Surfacing it both
			// shows live thinking and — crucially — feeds the output-token
			// progress estimate, so a model that reasons for minutes no longer
			// leaves the spinner frozen on "Receiving" with no movement.
			if reasoning := extraReasoningDelta(choice.Delta.JSON.ExtraFields); reasoning != "" {
				thinkingContent.WriteString(reasoning)
				sess.Progress(reasoning)
				streamChunk := provider.StreamChunk{
					Type:    provider.ContentBlockTypeThinking,
					Content: reasoning,
				}
				if _, err := callback(streamChunk); err != nil {
					return nil, err
				}
			}

			// Stream text content immediately
			if choice.Delta.Content != "" {
				textContent.WriteString(choice.Delta.Content)
				sess.Progress(choice.Delta.Content)
				streamChunk := provider.StreamChunk{
					Type:    provider.ContentBlockTypeText,
					Content: choice.Delta.Content,
				}
				if _, err := callback(streamChunk); err != nil {
					return nil, err
				}
			}

			// Accumulate tool calls
			for _, toolCall := range choice.Delta.ToolCalls {
				idx := int(toolCall.Index)
				if _, exists := toolCallBuffers[idx]; !exists {
					toolCallBuffers[idx] = &toolCallAccumulator{argsBuilder: strings.Builder{}}
				}
				acc := toolCallBuffers[idx]
				if toolCall.ID != "" {
					acc.id = toolCall.ID
				}
				if toolCall.Function.Name != "" {
					acc.name = toolCall.Function.Name
				}
				if toolCall.Function.Arguments != "" {
					acc.argsBuilder.WriteString(toolCall.Function.Arguments)
					sess.Progress(toolCall.Function.Arguments)
				}
			}
		}
	}

	if err := stream.Err(); err != nil {
		if stall := sess.StallError(); stall != nil {
			return nil, stall
		}
		return nil, err // Don't enhance - let retry wrapper handle it
	}

	// Log the response summary
	jlog.Trace("[openai RESPONSE] text=%d chars, thinking=%d chars, tools=%d, finish=%s, input_tokens=%d, output_tokens=%d, cached=%d",
		textContent.Len(), thinkingContent.Len(), len(toolCallBuffers), lastFinishReason, inputTokens, outputTokens, provider.TokenCount(cachedTokens))

	// Stream tool_use blocks to frontend (no execution - frontend handles that)
	if err := flushToolCalls(toolCallBuffers, callback); err != nil {
		return nil, err
	}

	inputTokens, inputTokensApproximate, outputTokens := estimateMissingUsage(req, inputTokens, outputTokens, textContent.String())

	return &provider.StreamResult{
		StopReason:             mapOpenAIFinishReason(lastFinishReason),
		InputTokens:            inputTokens,
		InputTokensApproximate: inputTokensApproximate,
		OutputTokens:           outputTokens,
		CachedTokens:           cachedTokens,
	}, nil
}

// estimateMissingUsage fills in token counts the upstream did not report — the
// case for OpenAI-compatible providers that ignore stream_options, and for any
// gateway that omits the usage block. Input falls back to the marshalled
// request plus its images and is flagged approximate so the UI can say so;
// output falls back to the accumulated assistant text. Both stream paths share
// it because both accumulate the same two inputs; anthropic and gemini have no
// analogue (anthropic always gets usage, and gemini never accumulates text).
func estimateMissingUsage(req provider.MessageRequest, inputTokens, outputTokens int, text string) (in int, approximate bool, out int) {
	in, out = inputTokens, outputTokens
	if in == 0 {
		in = provider.EstimateTokens(marshalMessagesForEstimate(req)) + estimateImageTokens(req)
		approximate = true
	}
	if out == 0 {
		out = provider.EstimateTokens(text)
	}
	return in, approximate, out
}

// marshalMessagesForEstimate serializes message request content for token estimation.
func marshalMessagesForEstimate(req provider.MessageRequest) string {
	var b strings.Builder
	b.WriteString(req.SystemPrompt)
	for _, msg := range req.Messages {
		b.WriteString(msg.Content)
		b.WriteString(msg.ToolName)
		if msg.ToolInput != nil {
			data, _ := json.Marshal(msg.ToolInput)
			b.Write(data)
		}
	}
	for _, t := range req.Tools {
		b.WriteString(t.Name)
		b.WriteString(t.Description)
	}
	return b.String()
}

// estimateImageTokens sums the per-image token estimate across every image part
// in the request, so the text-only chars/4 estimate is modality-aware. Image
// bytes are never marshaled (MediaPart.Data is json:"-"); the dimension-based
// heuristic lives on provider.EstimateImageTokens.
func estimateImageTokens(req provider.MessageRequest) int {
	total := 0
	for _, msg := range req.Messages {
		for _, part := range msg.Parts {
			total += provider.EstimateImageTokens(part)
		}
	}
	return total
}

// mapOpenAIFinishReason maps OpenAI's finish_reason to normalized stop_reason values.
// OpenAI values: "stop", "length", "tool_calls", "content_filter", "function_call"
// responsesErrorText renders a Responses-API error onto one line. The backend
// populates the triple inconsistently (a code with no message is common), so
// every present field is kept, and an empty one still names itself rather than
// surfacing as a blank error.
func responsesErrorText(code, message, param string) string {
	text := message
	if text == "" {
		text = "no detail reported"
	}
	var extra []string
	if code != "" {
		extra = append(extra, "code "+code)
	}
	if param != "" {
		extra = append(extra, "param "+param)
	}
	if len(extra) > 0 {
		text += " (" + strings.Join(extra, ", ") + ")"
	}
	return text
}

// mapResponsesIncompleteReason maps a Responses-API incomplete_details.reason
// onto provider.StopReason. An unrecognised reason returns "", leaving the
// computed stop reason alone: inventing a stop reason the rest of the pipeline
// doesn't know is worse than the finish it already inferred.
func mapResponsesIncompleteReason(reason string) provider.StopReason {
	switch reason {
	case "max_output_tokens":
		return provider.StopReasonMaxTokens
	case "content_filter":
		return provider.StopReasonContentFilter
	default:
		jlog.Trace("[openai-responses] unmapped incomplete reason %q", reason)
		return ""
	}
}

func mapOpenAIFinishReason(reason string) provider.StopReason {
	switch reason {
	case "stop":
		return provider.StopReasonEndTurn
	case "tool_calls", "function_call":
		return provider.StopReasonToolUse
	case "length":
		return provider.StopReasonMaxTokens
	case "content_filter":
		// Preserve the signal rather than collapsing into a clean end_turn — a
		// filtered (often empty) completion would otherwise be indistinguishable
		// from a normal finish.
		return provider.StopReasonContentFilter
	default:
		return provider.StopReasonEndTurn
	}
}
