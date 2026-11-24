/**
 * How to write a callable function (see `parseFunctionContract`), appended to the artifact-emission prompt when
 * `EnableCallableFunctions` resolves on for the requester. The example must stay accepted by the parser; the test
 * beside this file checks it.
 */
export const CALLABLE_FUNCTIONS_PROMPT_NOTE = `CALLABLE FUNCTIONS: When asked for a tool, a calculator, or a function to call with inputs, write a Python artifact (an HTML page only when a page is asked for), shaped like the example below: a module-level FUNCTION dict with only name (lowercase snake_case), description, inputs, outputs, and tests, and a plain top-level def run (not async).
Fields are number, integer, string, boolean, array (with items), or object (with "additionalProperties": False); every number and integer has an ASCII unit ("1" if dimensionless), in SI unless asked otherwise.
Besides type, description, and unit, a field may use only minimum, maximum, exclusiveMinimum, exclusiveMaximum, enum, default, maxLength, minItems, and maxItems.
run takes the input names as keyword arguments and returns a dict of the output names with plain JSON values (no NaN).
tests lists cases worked out independently of run, each with a name, an input holding every required input, an expected holding one or more outputs, and an optional tolerance of {"abs": ..., "rel": ...} for numbers.
<artifact identifier="beam-deflection" type="application/vnd.ant.python" title="Beam deflection">
FUNCTION = {
    "name": "beam_midspan_deflection",
    "description": "Midspan deflection of a simply supported beam under a uniform load.",
    "inputs": {
        "type": "object",
        "additionalProperties": False,
        "required": ["load", "span", "elastic_modulus", "second_moment"],
        "properties": {
            "load": {"type": "number", "unit": "N/m", "exclusiveMinimum": 0},
            "span": {"type": "number", "unit": "m", "exclusiveMinimum": 0},
            "elastic_modulus": {"type": "number", "unit": "Pa", "exclusiveMinimum": 0},
            "second_moment": {"type": "number", "unit": "m^4", "exclusiveMinimum": 0},
        },
    },
    "outputs": {
        "type": "object",
        "additionalProperties": False,
        "required": ["deflection"],
        "properties": {"deflection": {"type": "number", "unit": "m"}},
    },
    "tests": [
        {
            "name": "4 m steel beam",
            "input": {"load": 1000, "span": 4, "elastic_modulus": 2e11, "second_moment": 8e-6},
            "expected": {"deflection": 0.0020833},
            "tolerance": {"rel": 0.001},
        },
    ],
}


def run(load, span, elastic_modulus, second_moment):
    return {"deflection": 5 * load * span**4 / (384 * elastic_modulus * second_moment)}
</artifact>`;

/** The artifact-emission prompt with the callable-function note appended, or the prompt unchanged when off. */
export function withCallableFunctions(prompt: string, enabled: boolean): string {
  return enabled ? `${prompt}\n\n${CALLABLE_FUNCTIONS_PROMPT_NOTE}` : prompt;
}
