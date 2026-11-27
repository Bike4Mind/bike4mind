"""Drops `enum` from string schemas before the OpenAPI snapshot reaches openapi-generator.

The generator renders a string enum as a Kotlin `enum class`, and kotlinx.serialization throws on any value
the class does not list, so one new server value (a quest status, an error code) would fail the decode of the
whole response on every installed build, and shipped builds cannot be hot-fixed. Plain strings decode
anything; the app maps them onto its own types and treats unknown values as unknown.

GeneratedClientTest.noGeneratedModelEnumIsClosed guards the output. Run by `make generate-client`.
Usage: python3 open_enums.py <input.json> <output.json>
"""

import json
import sys


def is_string_enum(schema):
    values = schema.get("enum")
    if not isinstance(values, list) or not values:
        return False
    declared = schema.get("type")
    types = declared if isinstance(declared, list) else [declared]
    return "string" in types or all(isinstance(value, str) for value in values)


def open_enums(node):
    if isinstance(node, dict):
        if is_string_enum(node):
            del node["enum"]
            node.setdefault("type", "string")
        for value in node.values():
            open_enums(value)
    elif isinstance(node, list):
        for value in node:
            open_enums(value)


def main(source, destination):
    with open(source, encoding="utf-8") as handle:
        spec = json.load(handle)
    open_enums(spec)
    with open(destination, "w", encoding="utf-8") as handle:
        json.dump(spec, handle, indent=2, ensure_ascii=False)
        handle.write("\n")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
