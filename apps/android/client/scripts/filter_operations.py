"""Keeps only the listed operations in an OpenAPI document, then drops the component schemas they do not reach.

openapi-generator's FILTER normalizer only hides operations: it still emits a model for every component schema
and every inline schema of every operation, ~28k lines the app would compile and never call. Pruning the
document before generation keeps the committed client to what client/operations.txt names.

Run by `make generate-client`. Usage: python3 filter_operations.py <operations.txt> <input.json> <output.json>
"""

import json
import sys

HTTP_METHODS = {"get", "put", "post", "delete", "options", "head", "patch", "trace"}


def read_operations(path):
    with open(path, encoding="utf-8") as handle:
        lines = (line.split("#", 1)[0].strip() for line in handle)
        return [line for line in lines if line]


def keep_operations(spec, wanted):
    found = set()
    for path in list(spec.get("paths", {})):
        item = spec["paths"][path]
        for method in [key for key in item if key in HTTP_METHODS]:
            operation_id = item[method].get("operationId")
            if operation_id in wanted:
                found.add(operation_id)
            else:
                del item[method]
        if not any(key in HTTP_METHODS for key in item):
            del spec["paths"][path]
    missing = sorted(set(wanted) - found)
    if missing:
        sys.exit(f"filter_operations: not in the spec: {', '.join(missing)}")


def collect_refs(node, refs):
    if isinstance(node, dict):
        ref = node.get("$ref")
        if isinstance(ref, str):
            refs.add(ref)
        for value in node.values():
            collect_refs(value, refs)
    elif isinstance(node, list):
        for value in node:
            collect_refs(value, refs)


def prune_components(spec):
    components = spec.get("components", {})
    reachable = set()
    pending = set()
    collect_refs(spec.get("paths", {}), pending)
    while pending:
        ref = pending.pop()
        if ref in reachable or not ref.startswith("#/components/"):
            continue
        reachable.add(ref)
        _, _, section, name = ref.split("/", 3)
        collect_refs(components.get(section, {}).get(name), pending)
    for section in [key for key in components if key != "securitySchemes"]:
        entries = components[section]
        for name in list(entries):
            if f"#/components/{section}/{name}" not in reachable:
                del entries[name]
        if not entries:
            del components[section]


def main(operations_path, source, destination):
    wanted = read_operations(operations_path)
    with open(source, encoding="utf-8") as handle:
        spec = json.load(handle)
    keep_operations(spec, set(wanted))
    prune_components(spec)
    with open(destination, "w", encoding="utf-8") as handle:
        json.dump(spec, handle, indent=2, ensure_ascii=False)
        handle.write("\n")


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit("usage: filter_operations.py <operations.txt> <input.json> <output.json>")
    main(sys.argv[1], sys.argv[2], sys.argv[3])
