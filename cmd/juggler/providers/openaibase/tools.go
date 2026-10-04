//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaibase

import (
	"encoding/json"

	"juggler/cmd/juggler/providers/provider"
	"juggler/internal/jlog"

	"github.com/openai/openai-go/v3/shared"
)

// The two OpenAI wires (chat_completions.go, responses.go) encode tools and
// tool_choice into different SDK unions, but what they say is decided here, once,
// so the two encoders cannot come to disagree about it.

// toolChoiceWire is what a request's tool_choice says, independent of which
// wire carries it.
type toolChoiceWire int

const (
	toolChoiceOmit     toolChoiceWire = iota // send no tool_choice: the model decides
	toolChoiceNamed                          // force the one tool named by ToolChoice.Name
	toolChoiceRequired                       // some tool must be called
	toolChoiceNone                           // no tool may be called
)

// decideToolChoice maps the provider-agnostic ToolChoice onto what the wire
// should say. nil, auto and any unknown mode are toolChoiceOmit. When
// downgradeForcedTool is set, a forced single tool is also toolChoiceOmit (the
// tool stays offered), for vendors that reject a named tool_choice — some only
// in thinking mode — so the fail-safe default holds on both wires.
func decideToolChoice(tc *provider.ToolChoice, downgradeForcedTool bool) toolChoiceWire {
	if tc == nil {
		return toolChoiceOmit
	}
	switch tc.Mode {
	case provider.ToolChoiceTool:
		if tc.Name == "" || downgradeForcedTool {
			return toolChoiceOmit
		}
		return toolChoiceNamed
	case provider.ToolChoiceAny:
		return toolChoiceRequired
	case provider.ToolChoiceNone:
		return toolChoiceNone
	default:
		return toolChoiceOmit
	}
}

// toolParameters decodes a tool's JSON input schema into the parameters map
// both wires send. A schema that does not decode is sent as empty parameters
// and logged loudly: the model then has no argument shape to follow and tends to
// fall back to writing tool calls as text, so the log is where that is explained.
func toolParameters(tool provider.ToolDefinition) shared.FunctionParameters {
	var schemaMap map[string]any
	if err := json.Unmarshal(tool.InputSchema, &schemaMap); err != nil {
		jlog.Error("Failed to unmarshal input schema for tool '%s': %v", tool.Name, err)
		jlog.Error("Raw InputSchema bytes (%d bytes): %s", len(tool.InputSchema), string(tool.InputSchema))
		jlog.Error("Tool will be sent with empty parameters, causing LLM to fall back to text-based tool syntax")
		return shared.FunctionParameters{}
	}
	return shared.FunctionParameters(schemaMap)
}
