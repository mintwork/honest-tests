"""honest-tests pytest extractor.

Reads a JSON list of {"path", "source"} objects on stdin, parses each source with the standard
library `ast` module and prints a JSON list of language-neutral TestFileModel objects (without
`lines`, which the Node side adds) or {"error": "..."} entries.

Safety: the audited code is never imported or executed. Sources arrive on stdin, and the script is
started with `python3 -I -S` from a directory outside the audited repository, so nothing there can
shadow a module we import (`ast`, `json`, `sys`).
"""

import ast
import json
import re
import sys

if sys.version_info < (3, 9):
    sys.stderr.write("honest-tests needs Python 3.9+ for the pytest adapter\n")
    sys.exit(3)

HELPER_ASSERT = re.compile(r"^(expect|assert|verify|check|ensure|should|validate)([A-Z_]|$)")

# unittest.TestCase assertion methods -> (matcherKind, negated). Unknown self.assert* -> 'other'.
UNITTEST_KINDS = {
    "assertEqual": ("equal", False), "assertEquals": ("equal", False), "failUnlessEqual": ("equal", False),
    "assertNotEqual": ("equal", True), "assertNotEquals": ("equal", True),
    "assertAlmostEqual": ("equal", False), "assertNotAlmostEqual": ("equal", True),
    "assertCountEqual": ("equal", False), "assertDictEqual": ("equal", False), "assertListEqual": ("equal", False),
    "assertSetEqual": ("equal", False), "assertTupleEqual": ("equal", False), "assertSequenceEqual": ("equal", False),
    "assertMultiLineEqual": ("equal", False), "assertIs": ("equal", False), "assertIsNot": ("equal", True),
    "assertTrue": ("truthy", False), "assert_": ("truthy", False), "failUnless": ("truthy", False),
    "assertFalse": ("falsy", False), "failIf": ("falsy", False),
    "assertIsNone": ("null", False), "assertIsNotNone": ("defined", False),
    "assertIsInstance": ("type", False), "assertNotIsInstance": ("type", True),
    "assertGreater": ("compare-other", False), "assertLess": ("compare-other", False),
    "assertLessEqual": ("compare-other", False), "assertGreaterEqual": ("compare-gte", False),
    "assertRaises": ("throws", False), "assertRaisesRegex": ("throws", False), "assertRaisesRegexp": ("throws", False),
    "assertWarns": ("throws", False), "assertWarnsRegex": ("throws", False),
    "assertIn": ("other", False), "assertNotIn": ("other", True),
    "assertRegex": ("other", False), "assertNotRegex": ("other", True),
}
# Methods that take (actual, expected); the rest take (subject) or (expected-type, ...).
TWO_ARG = {k for k, (kind, _) in UNITTEST_KINDS.items() if kind in ("equal", "compare-other", "compare-gte", "type")}

# unittest.mock assertion methods.
MOCK_ASSERTS = re.compile(r"^assert_(not_)?(called|awaited|any_call|any_await|has_calls|has_awaits)\w*$")
# Look like mock assertions but are auto-created child mocks: always truthy (`assert m.called_once_with(1)`).
FAKE_MOCK_ASSERTS = {
    "called_once_with", "called_with", "called_once", "has_calls", "any_call", "not_called",
    "awaited_once_with", "awaited_with", "awaited_once", "has_awaits", "any_await", "not_awaited",
}
MOCK_FACTORIES = {"Mock", "MagicMock", "AsyncMock", "NonCallableMock", "NonCallableMagicMock", "create_autospec", "PropertyMock"}
RAISES = {"raises", "warns", "deprecated_call"}
REGRESSION_FIXTURES = {"data_regression", "file_regression", "num_regression", "dataframe_regression",
                       "ndarrays_regression", "image_regression"}
SWALLOWING_EXC = {"Exception", "BaseException", "AssertionError"}


def text(node):
    return ast.unparse(node)


def dotted(node):
    """`a.b.c` for Name/Attribute chains, else None."""
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
        return ".".join(reversed(parts))
    return None


def last_attr(node):
    if isinstance(node, ast.Attribute):
        return node.attr
    if isinstance(node, ast.Name):
        return node.id
    return None


def str_const(node):
    return node.value if isinstance(node, ast.Constant) and isinstance(node.value, str) else None


def is_const(node):
    return isinstance(node, ast.Constant) or (
        isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd)) and isinstance(node.operand, ast.Constant)
    )


class File:
    def __init__(self, source):
        self.source = source
        self.lines = source.splitlines()
        self.tree = ast.parse(source, type_comments=False)
        self.parent = {}
        for node in ast.walk(self.tree):
            for child in ast.iter_child_nodes(node):
                self.parent[child] = node

    def col(self, node):
        """1-based character column (ast columns are UTF-8 byte offsets)."""
        line = self.lines[node.lineno - 1] if node.lineno - 1 < len(self.lines) else ""
        return len(line.encode("utf-8")[: node.col_offset].decode("utf-8", "replace")) + 1

    def line_text(self, start, end):
        chunk = self.lines[start - 1 : min(end, start + 2)]
        return " ".join(l.strip() for l in chunk)[:200]

    def ancestors(self, node):
        out = []
        cur = self.parent.get(node)
        while cur is not None:
            out.append(cur)
            cur = self.parent.get(cur)
        return out  # innermost first


def describe(node):
    t = text(node)
    if is_const(node):
        v = node.value if isinstance(node, ast.Constant) else node.operand.value
        if v is Ellipsis or isinstance(v, bytes):
            return {"text": t, "kind": "other"}
        if isinstance(node, ast.UnaryOp):
            v = -v if isinstance(node.op, ast.USub) else v
        if isinstance(v, complex) or (isinstance(v, float) and v != v or v in (float("inf"), float("-inf"))):
            return {"text": t, "kind": "other"}  # not representable in JSON
        return {"text": t, "kind": "literal", "literalValue": v}
    if isinstance(node, ast.Name):
        return {"text": t, "kind": "identifier"}
    if isinstance(node, (ast.Attribute, ast.Subscript)):
        info = {"text": t, "kind": "member"}
        if isinstance(node, ast.Attribute) and node.attr in FAKE_MOCK_ASSERTS:
            info["alwaysTruthy"] = True
        return info
    if isinstance(node, ast.Call):
        info = {"text": t, "kind": "call", "calleeText": text(node.func)}
        if isinstance(node.func, ast.Attribute) and node.func.attr in FAKE_MOCK_ASSERTS:
            info["alwaysTruthy"] = True
        return info
    if isinstance(node, (ast.Dict, ast.Set)):
        has = node.keys if isinstance(node, ast.Dict) else node.elts
        return {"text": t, "kind": "object" if has else "other"}
    if isinstance(node, (ast.List, ast.Tuple)):
        return {"text": t, "kind": "array" if node.elts else "other"}
    if isinstance(node, ast.Lambda):
        return {"text": t, "kind": "function"}
    if isinstance(node, ast.JoinedStr) and all(isinstance(v, ast.Constant) for v in node.values):
        return {"text": t, "kind": "literal", "literalValue": "".join(v.value for v in node.values)}
    return {"text": t, "kind": "other"}


# ---------------------------------------------------------------------------------------------
# Literals the test built itself (`p = {"service": "s3"}; assert p["service"] == "s3"`)

PURE_CONTAINERS = (ast.BinOp, ast.UnaryOp, ast.BoolOp, ast.IfExp, ast.Dict, ast.List, ast.Tuple, ast.Set,
                   ast.JoinedStr, ast.FormattedValue, ast.Starred, ast.Compare)


def resolve_literal(node, pure, depth=0):
    """The literal node a pure read evaluates to, or None when it isn't an own key/index of a literal."""
    if depth > 20:
        return None
    if isinstance(node, ast.Name):
        return resolve_literal(pure[node.id][1], pure, depth + 1) if node.id in pure else None
    if not isinstance(node, ast.Subscript):
        return node
    obj = resolve_literal(node.value, pure, depth + 1)
    key = resolve_literal(node.slice, pure, depth + 1)
    if obj is None or not isinstance(key, ast.Constant):
        return None
    if isinstance(obj, ast.Dict):
        for k, v in reversed(list(zip(obj.keys, obj.values))):
            if k is None:
                return None  # **spread: give up rather than guess
            if isinstance(k, ast.Constant) and k.value == key.value and type(k.value) is type(key.value):
                return resolve_literal(v, pure, depth + 1)
        return None
    if isinstance(obj, (ast.List, ast.Tuple)) and isinstance(key.value, int) and not isinstance(key.value, bool):
        if any(isinstance(e, ast.Starred) for e in obj.elts) or not -len(obj.elts) <= key.value < len(obj.elts):
            return None
        return resolve_literal(obj.elts[key.value], pure, depth + 1)
    return None


def is_pure(node, pure):
    if isinstance(node, ast.Constant):
        return True
    if isinstance(node, ast.Name):
        return node.id in pure
    if isinstance(node, ast.Dict):
        return all((k is None or is_pure(k, pure)) and is_pure(v, pure) for k, v in zip(node.keys, node.values))
    if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
        return all(is_pure(e, pure) for e in node.elts)
    if isinstance(node, ast.Starred):
        return is_pure(node.value, pure)
    if isinstance(node, ast.JoinedStr):
        return all(is_pure(v, pure) for v in node.values)
    if isinstance(node, ast.FormattedValue):
        return is_pure(node.value, pure) and node.conversion == -1 and node.format_spec is None
    if isinstance(node, ast.UnaryOp):
        return is_pure(node.operand, pure)
    if isinstance(node, ast.BinOp):
        return is_pure(node.left, pure) and is_pure(node.right, pure)
    if isinstance(node, ast.BoolOp):
        return all(is_pure(v, pure) for v in node.values)
    if isinstance(node, ast.IfExp):
        return is_pure(node.test, pure) and is_pure(node.body, pure) and is_pure(node.orelse, pure)
    if isinstance(node, ast.Subscript):
        return is_pure(node.value, pure) and is_pure(node.slice, pure) and resolve_literal(node, pure) is not None
    return False


def is_zero_division(n):
    return isinstance(n, ast.BinOp) and isinstance(n.op, (ast.Div, ast.FloorDiv, ast.Mod)) \
        and isinstance(n.right, ast.Constant) and n.right.value == 0 and not isinstance(n.right.value, bool)


def first_pure_ref(node, pure):
    for n in ast.walk(node):
        if isinstance(n, ast.Name) and n.id in pure:
            return n.id
    return None


# ---------------------------------------------------------------------------------------------


class Extractor:
    def __init__(self, path, source, support_helpers=frozenset()):
        self.support_helpers = support_helpers
        self.f = File(source)
        self.path = path
        base = path.replace("\\", "/").rsplit("/", 1)[-1]
        stem = base[:-3] if base.endswith(".py") else base
        if stem.startswith("test_"):
            stem = stem[5:]
        elif stem.endswith("_test"):
            stem = stem[:-5]
        self.unit = stem.lower()
        self.helpers = set()
        self.raisers = set()
        self.unit_aliases = set()  # local names bound to the module under test
        self.module_calls = set()  # (alias, attr) for `alias.attr(...)` calls anywhere in the file

    # --- vocabulary ------------------------------------------------------------------------

    def scan_vocab(self):
        tree = self.f.tree
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for a in node.names:
                    if a.name.split(".")[-1].lower() == self.unit:
                        self.unit_aliases.add(a.asname or a.name)
            elif isinstance(node, ast.ImportFrom):
                for a in node.names:
                    if a.name.lower() == self.unit:
                        self.unit_aliases.add(a.asname or a.name)
            elif isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                d = dotted(node.func.value)
                if d:
                    self.module_calls.add((d, node.func.attr))
        # Functions/methods in this file whose bodies assert; iterate to a fixpoint (helpers calling helpers).
        funcs = [n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]
        # Functions that raise (`def level3(): return 1 / 0`), so `try: level1()` is sure to reach the except.
        self.raisers = set()
        changed = True
        while changed:
            changed = False
            for fn in funcs:
                if fn.name in self.raisers:
                    continue
                if any(isinstance(n, ast.Raise) or is_zero_division(n)
                       or (isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id in self.raisers)
                       for n in ast.walk(fn)):
                    self.raisers.add(fn.name)
                    changed = True
        changed = True
        while changed:
            changed = False
            for fn in funcs:
                if fn.name in self.helpers or fn.name.startswith("test"):
                    continue
                if any(self.is_assertion_node(n) for n in ast.walk(fn)):
                    self.helpers.add(fn.name)
                    changed = True

    def call_name(self, call):
        f = call.func
        if isinstance(f, ast.Name):
            return f.id
        if isinstance(f, ast.Attribute):
            return f.attr
        return None

    def is_helper_call(self, call):
        name = self.call_name(call)
        if not name:
            return False
        f = call.func
        local = isinstance(f, ast.Name) or (isinstance(f, ast.Attribute) and isinstance(f.value, ast.Name) and f.value.id in ("self", "cls"))
        if local and name in self.helpers:
            return True
        if name in self.support_helpers:
            return True
        return bool(HELPER_ASSERT.match(name.lstrip("_")))

    def is_assertion_node(self, n):
        if isinstance(n, ast.Assert):
            return True
        if isinstance(n, ast.Call):
            if self.is_fail_call(n) or self.raises_kind(n) or self.is_helper_call(n):
                return True
        return False

    def is_fail_call(self, call):
        d = dotted(call.func) or ""
        return d in ("pytest.fail", "self.fail", "fail", "unittest.TestCase.fail")

    def raises_kind(self, call):
        d = dotted(call.func) or ""
        if d.startswith("pytest.") and d[7:] in RAISES:
            return True
        return d in ("raises", "warns")

    # --- mocks -----------------------------------------------------------------------------

    def patch_target(self, call):
        """(module, attr) for patch('a.b.c') / patch.object(o, 'x') / monkeypatch.setattr(...), else None."""
        parts = (dotted(call.func) or "").split(".")
        name, args = parts[-1], call.args
        owner = parts[-2] if len(parts) >= 2 else ""
        if name == "patch" and (len(parts) == 1 or owner in ("mock", "mocker", "unittest")):
            target = str_const(args[0]) if args else None
            for kw in call.keywords:
                if kw.arg == "target":
                    target = str_const(kw.value)
            if not target:
                return None
            mod, _, attr = target.rpartition(".")
            return (mod, attr) if mod else (target, None)
        if owner == "patch" and name == "object" and len(args) >= 2:
            attr = str_const(args[1])
            return (text(args[0]), attr) if attr else None
        if owner == "patch" and name == "multiple" and args:
            return (str_const(args[0]) or text(args[0]), None)
        if owner == "monkeypatch" and name in ("setattr", "delattr") and args:
            s = str_const(args[0])
            if s is not None and len(args) <= 2:
                mod, _, attr = s.rpartition(".")
                return (mod, attr) if mod else None
            attr = str_const(args[1]) if len(args) >= 2 else None
            return (text(args[0]), attr) if attr else None
        return None

    def module_mocks(self):
        out = []
        for node in ast.walk(self.f.tree):
            if not isinstance(node, ast.Call):
                continue
            pt = self.patch_target(node)
            if not pt:
                continue
            mod, attr = pt
            seg = mod.split(".")[-1].lower()
            if self.sets_plain_state(node):
                continue
            scope, scope_node = None, None
            for a in self.f.ancestors(node):
                if isinstance(a, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    scope, scope_node = self.qualname(a), a
                    break
            # Patching a name in the unit's namespace is how Python mocks a *dependency*; it only replaces
            # the unit itself when the test then calls that very name through the unit module.
            # Look for that call in the test the patch belongs to (the whole file for module-level patches).
            calls = self.module_calls if scope_node is None else self.calls_in(scope_node)
            is_unit = bool(
                self.unit
                and attr
                and seg == self.unit
                and any((alias, attr) in calls for alias in self.unit_aliases | {mod})
            )
            entry = {
                "specifier": mod + "." + attr if attr else mod,
                "line": node.lineno,
                "text": self.f.line_text(node.lineno, node.lineno),
                "isUnitUnderTest": is_unit,
                "partial": False,
            }
            if scope:
                entry["scope"] = scope
            out.append(entry)
        return out

    def calls_in(self, root):
        out = set()
        for n in ast.walk(root):
            if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute):
                d = dotted(n.func.value)
                if d:
                    out.add((d, n.func.attr))
        return out

    def sets_plain_state(self, call):
        """`monkeypatch.setattr(mod, "FLAG", False)` / `patch.object(m, "X", [])` set state; they don't mock code."""
        parts = (dotted(call.func) or "").split(".")
        name, owner = parts[-1], parts[-2] if len(parts) >= 2 else ""
        value = None
        if owner == "monkeypatch" and name == "setattr":
            value = call.args[1] if len(call.args) == 2 and str_const(call.args[0]) is not None else (call.args[2] if len(call.args) >= 3 else None)
        elif name == "patch" and len(call.args) >= 2:
            value = call.args[1]
        elif owner == "patch" and name == "object" and len(call.args) >= 3:
            value = call.args[2]
        for kw in call.keywords:
            if kw.arg in ("new", "value"):
                value = kw.value
        if value is None:
            return False
        if isinstance(value, (ast.Constant, ast.List, ast.Dict, ast.Set, ast.Tuple, ast.JoinedStr, ast.ListComp, ast.DictComp, ast.SetComp)):
            return True
        if isinstance(value, ast.UnaryOp) and is_const(value):
            return True
        if isinstance(value, ast.Call):
            f = value.func
            return (isinstance(f, ast.Name) and f.id in ("set", "dict", "list", "tuple", "frozenset", "str", "int")) or (
                isinstance(f, ast.Attribute) and f.attr == "copy")
        return False

    def qualname(self, fn):
        names = [fn.name]
        for a in self.f.ancestors(fn):
            if isinstance(a, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                names.append(a.name)
        return "::".join(reversed(names))

    def is_mock_factory(self, call):
        name = self.call_name(call)
        if name in MOCK_FACTORIES:
            return True
        return bool(self.patch_target(call))

    def mock_setups(self, root, skip_defs):
        out = []

        def visit(n):
            if skip_defs and n is not root and isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                return
            if isinstance(n, ast.Assign):
                for tgt in n.targets:
                    if isinstance(tgt, ast.Attribute) and tgt.attr in ("return_value", "side_effect"):
                        out.append({"target": text(tgt.value), "line": n.lineno, "configuresReturn": True})
                if len(n.targets) == 1 and isinstance(n.targets[0], ast.Name) and isinstance(n.value, ast.Call) and self.is_mock_factory(n.value):
                    conf = any(kw.arg in ("return_value", "side_effect") for kw in n.value.keywords)
                    out.append({"target": n.targets[0].id, "line": n.lineno, "configuresReturn": conf})
            if isinstance(n, (ast.With, ast.AsyncWith)):
                for item in n.items:
                    e = item.context_expr
                    if isinstance(e, ast.Call) and self.is_mock_factory(e) and isinstance(item.optional_vars, ast.Name):
                        conf = any(kw.arg in ("return_value", "side_effect") for kw in e.keywords)
                        out.append({"target": item.optional_vars.id, "line": n.lineno, "configuresReturn": conf})
            for c in ast.iter_child_nodes(n):
                visit(c)

        visit(root)
        return out

    # --- assertions ------------------------------------------------------------------------

    def handler_swallows(self, handler):
        t = handler.type
        if t is None:
            caught = True
        else:
            names = t.elts if isinstance(t, ast.Tuple) else [t]
            caught = any(last_attr(x) in SWALLOWING_EXC for x in names)
        # A handler that asserts again (`except AssertionError: assert other`) fails the test itself.
        return caught and not self.contains_fail_or_raise(handler.body) and not self.branch_asserts(handler.body)

    def contains_fail_or_raise(self, stmts):
        for s in stmts:
            for n in ast.walk(s):
                if isinstance(n, ast.Raise):
                    return True
                if isinstance(n, ast.Call) and self.is_fail_call(n):
                    return True
                if isinstance(n, ast.Assert) and self.always_false(n.test):
                    return True
        return False

    def always_raises(self, stmts):
        """The block raises for sure-ish: `raise`, `fail()`, `1 / 0`, or a call to a local function that does."""
        if self.contains_fail_or_raise(stmts):
            return True
        for s in stmts:
            for n in ast.walk(s):
                if is_zero_division(n):
                    return True
                if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id in self.raisers:
                    return True
        return False

    def always_false(self, test):
        return isinstance(test, ast.Constant) and not test.value

    def catch_guarded(self, try_node, handler):
        if self.contains_fail_or_raise(try_node.orelse) or self.always_raises(try_node.body):
            return True
        if any(isinstance(n, ast.Assert) for s in try_node.body for n in ast.walk(s)):
            return True  # the try already asserted; the catch is an alternative check, not the only one
        parent = self.f.parent.get(try_node)
        body = None
        for field in ("body", "orelse", "finalbody"):
            seq = getattr(parent, field, None)
            if isinstance(seq, list) and try_node in seq:
                body = seq
        if not body:
            return False
        after = body[body.index(try_node) + 1 :]
        if not after:
            return False
        if any(isinstance(n, ast.Return) for s in handler.body for n in ast.walk(s)) and self.contains_fail_or_raise(after):
            return True
        flags = {
            t.id
            for s in handler.body
            for n in ast.walk(s)
            if isinstance(n, ast.Assign) and isinstance(n.value, ast.Constant) and isinstance(n.value.value, bool)
            for t in n.targets
            if isinstance(t, ast.Name)
        }
        if not flags:
            return False
        for s in after:
            for n in ast.walk(s):
                if self.is_assertion_node(n) and any(isinstance(x, ast.Name) and x.id in flags for x in ast.walk(n)):
                    return True
        return False

    def branch_asserts(self, stmts):
        return any(self.is_assertion_node(n) for s in stmts for n in ast.walk(s))

    def every_branch_asserts(self, if_node):
        if not if_node.orelse or not self.branch_asserts(if_node.body):
            return False
        if len(if_node.orelse) == 1 and isinstance(if_node.orelse[0], ast.If):
            return self.every_branch_asserts(if_node.orelse[0])
        return self.branch_asserts(if_node.orelse)

    def search_loop_hit(self, if_node):
        """`for x in xs: if match: assert ...; break` + `else: pytest.fail()`: the branch is the only way out."""
        if not any(isinstance(st, ast.Break) for st in if_node.body):
            return False
        for a in self.f.ancestors(if_node):
            if isinstance(a, (ast.For, ast.AsyncFor, ast.While)):
                return self.contains_fail_or_raise(a.orelse)
            if isinstance(a, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
                return False
        return False

    def guard_operand(self, test):
        node = test
        while True:
            if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
                node = node.operand
            elif isinstance(node, ast.Compare) and len(node.ops) == 1 and isinstance(node.ops[0], (ast.Eq, ast.NotEq, ast.Is, ast.IsNot)):
                if is_const(node.comparators[0]):
                    node = node.left
                elif is_const(node.left):
                    node = node.comparators[0]
                else:
                    break
            else:
                break
        return text(node)

    def context(self, node, body_root):
        ctx = {"inSwallowingTry": False, "inCatch": False, "catchGuarded": False, "inConditional": False}
        guards = []
        child = node
        for a in self.f.ancestors(node):
            if a is body_root:
                break
            if isinstance(a, ast.ExceptHandler):
                ctx["inCatch"] = True
                try_node = self.f.parent.get(a)
                if isinstance(try_node, ast.Try) and self.catch_guarded(try_node, a):
                    ctx["catchGuarded"] = True
            if isinstance(a, ast.Try) and child in a.body and any(self.handler_swallows(h) for h in a.handlers):
                ctx["inSwallowingTry"] = True
            if isinstance(a, (ast.With, ast.AsyncWith)) and child in a.body:
                for item in a.items:
                    e = item.context_expr
                    if isinstance(e, ast.Call) and (dotted(e.func) or "").split(".")[-1] == "suppress":
                        if any(last_attr(x) in SWALLOWING_EXC for x in e.args):
                            ctx["inSwallowingTry"] = True
            if isinstance(a, ast.If) and child is not a.test:
                head = a
                while isinstance(self.f.parent.get(head), ast.If) and self.f.parent[head].orelse == [head]:
                    head = self.f.parent[head]
                if not self.every_branch_asserts(head) and not self.search_loop_hit(a):
                    ctx["inConditional"] = True
                    guards.append(self.guard_operand(a.test))
            if isinstance(a, ast.IfExp) and child is not a.test and not isinstance(self.f.parent.get(a), ast.withitem):
                # (`with pytest.warns() if warn else nullcontext():` is a parametrized expectation, not a skip)
                ctx["inConditional"] = True
                guards.append(self.guard_operand(a.test))
            if isinstance(a, ast.BoolOp) and child is not a.values[0]:
                ctx["inConditional"] = True
                guards.append(self.guard_operand(a.values[0]))
            child = a
        if guards:
            ctx["guards"] = guards
        return ctx

    def assertion(self, node, body_root, subject, matcher, kind, negated, args, pure):
        def info(n):
            return self.with_own_literal(describe(n), n, pure)

        subj = None
        if subject is not None:
            subj = info(subject)
            if subj["kind"] == "identifier" and subj["text"] in self.aliases:
                subj["aliasCalleeText"] = self.aliases[subj["text"]]
        end = getattr(node, "end_lineno", node.lineno) or node.lineno
        return {
            "line": node.lineno,
            "column": self.f.col(node),
            "text": self.f.line_text(node.lineno, end),
            "style": "assert",
            "subject": subj,
            "matcher": matcher,
            "matcherKind": kind,
            "negated": negated,
            "args": [info(a) for a in args],
            "async": False,
            "awaitedOrReturned": True,
            "context": self.context(node, body_root),
        }

    def with_own_literal(self, info, node, pure):
        if info["kind"] == "literal" or not is_pure(node, pure):
            return info
        info = dict(info, pureLiteral=True)
        name = first_pure_ref(node, pure)
        if name:
            info["ownLiteral"] = {"name": name, "line": pure[name][0]}
        return info

    def is_snapshot(self, node):
        if isinstance(node, ast.Name) and node.id == "snapshot":
            return True
        if isinstance(node, ast.Call):
            root = node.func
            while isinstance(root, (ast.Attribute, ast.Call)):
                root = root.value if isinstance(root, ast.Attribute) else root.func
            return isinstance(root, ast.Name) and root.id == "snapshot"
        return False

    def compare_assertion(self, stmt, body_root, test, pure):
        left, op, right = test.left, test.ops[0], test.comparators[0]
        if self.is_snapshot(right) or self.is_snapshot(left):
            other = left if self.is_snapshot(right) else right
            return self.assertion(stmt, body_root, other, "snapshot", "snapshot", False, [], pure)
        if isinstance(op, (ast.In, ast.NotIn)):
            return self.assertion(stmt, body_root, right, "in", "other", isinstance(op, ast.NotIn), [left], pure)
        flip = {ast.Lt: ast.Gt, ast.Gt: ast.Lt, ast.LtE: ast.GtE, ast.GtE: ast.LtE}
        # Yoda conditions (`0 <= len(x)`, `3 == f()`): the literal is the expected side.
        if is_const(left) and not is_const(right):
            left, right = right, left
            if type(op) in flip:
                op = flip[type(op)]()
        if isinstance(op, (ast.Eq, ast.NotEq, ast.Is, ast.IsNot)) and isinstance(left, ast.Call) and text(left) == text(right):
            # `Style(bold=True) == Style(bold=True)` runs __eq__ on two fresh objects, and
            # `get(x) is get(x)` checks caching: both are real checks, not self-comparisons.
            sym = {ast.Eq: "==", ast.NotEq: "!=", ast.Is: "is", ast.IsNot: "is not"}[type(op)]
            return self.assertion(stmt, body_root, left, sym, "other", isinstance(op, (ast.NotEq, ast.IsNot)), [right], pure)
        if isinstance(op, ast.Eq):
            return self.assertion(stmt, body_root, left, "==", "equal", False, [right], pure)
        if isinstance(op, ast.NotEq):
            return self.assertion(stmt, body_root, left, "!=", "equal", True, [right], pure)
        if isinstance(op, (ast.Is, ast.IsNot)):
            neg = isinstance(op, ast.IsNot)
            if isinstance(right, ast.Constant) and right.value is None:
                return self.assertion(stmt, body_root, left, "is not None" if neg else "is None", "defined" if neg else "null", False, [], pure)
            return self.assertion(stmt, body_root, left, "is not" if neg else "is", "equal", neg, [right], pure)
        if isinstance(op, ast.GtE):
            return self.assertion(stmt, body_root, left, ">=", "compare-gte", False, [right], pure)
        sym = {ast.Lt: "<", ast.Gt: ">", ast.LtE: "<="}[type(op)]
        return self.assertion(stmt, body_root, left, sym, "compare-other", False, [right], pure)

    def assert_stmt(self, stmt, body_root, pure):
        test = stmt.test
        if isinstance(test, ast.Compare) and len(test.ops) == 1:
            return self.compare_assertion(stmt, body_root, test, pure)
        if isinstance(test, ast.UnaryOp) and isinstance(test.op, ast.Not):
            return self.assertion(stmt, body_root, test.operand, "not", "falsy", False, [], pure)
        if isinstance(test, ast.Call) and isinstance(test.func, ast.Name) and test.func.id == "isinstance" and len(test.args) == 2:
            return self.assertion(stmt, body_root, test.args[0], "isinstance", "type", False, [test.args[1]], pure)
        if isinstance(test, ast.Compare):
            # Chained (`1 <= n <= 2`): the subject is the first operand that isn't a literal.
            operands = [test.left] + test.comparators
            subject = next((o for o in operands if not is_const(o)), test.left)
            return self.assertion(stmt, body_root, subject, "compare", "other", False, [], pure)
        return self.assertion(stmt, body_root, test, "assert", "truthy", False, [], pure)

    def call_assertion(self, call, body_root, pure):
        """An assertion for a call, 'helper' for an opaque asserting helper, or None."""
        f = call.func
        name = self.call_name(call)
        d = dotted(f) or ""
        if self.is_fail_call(call):
            return "helper"
        if self.raises_kind(call):
            return self.assertion(call, body_root, None, d.split(".")[-1], "throws", False, [], pure)
        if isinstance(f, ast.Attribute) and isinstance(f.value, ast.Name) and f.value.id == "self" and name in UNITTEST_KINDS:
            kind, neg = UNITTEST_KINDS[name]
            a = call.args
            if kind == "throws" or not a:
                return self.assertion(call, body_root, None, name, kind, neg, [], pure)
            rest = [a[1]] if name in TWO_ARG and len(a) > 1 else []
            return self.assertion(call, body_root, a[0], name, kind, neg, rest, pure)
        if isinstance(f, ast.Attribute) and MOCK_ASSERTS.match(f.attr):
            return self.assertion(call, body_root, f.value, f.attr, "called", f.attr.startswith("assert_not_"), [], pure)
        if isinstance(f, ast.Attribute) and isinstance(f.value, ast.Name) and f.value.id == "snapshot" and f.attr == "assert_match":
            return self.assertion(call, body_root, call.args[0] if call.args else None, "assert_match", "snapshot", False, [], pure)
        if isinstance(f, ast.Attribute) and f.attr == "check" and isinstance(f.value, ast.Name) and f.value.id in REGRESSION_FIXTURES:
            return self.assertion(call, body_root, call.args[0] if call.args else None, "check", "snapshot", False, [], pure)
        if self.is_helper_call(call):
            return "helper"
        return None

    # --- own literal bindings ---------------------------------------------------------------

    def own_literal_bindings(self, fn):
        counts = {}
        decls = {}

        def bump(name):
            counts[name] = counts.get(name, 0) + 1

        args = fn.args
        for a in args.posonlyargs + args.args + args.kwonlyargs + [args.vararg, args.kwarg]:
            if a is not None:
                bump(a.arg)
        for n in ast.walk(fn):
            if n is fn:
                continue
            if isinstance(n, ast.Name) and isinstance(n.ctx, (ast.Store, ast.Del)):
                bump(n.id)
            elif isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                bump(n.name)
            elif isinstance(n, (ast.Global, ast.Nonlocal)):
                for nm in n.names:
                    counts[nm] = 99
            elif isinstance(n, ast.arg):
                bump(n.arg)
            elif isinstance(n, ast.ExceptHandler) and n.name:
                bump(n.name)
            elif isinstance(n, (ast.Import, ast.ImportFrom)):
                for a in n.names:
                    bump((a.asname or a.name).split(".")[0])
        for stmt in ast.walk(fn):
            if isinstance(stmt, (ast.Assign, ast.AnnAssign)):
                targets = stmt.targets if isinstance(stmt, ast.Assign) else [stmt.target]
                if len(targets) == 1 and isinstance(targets[0], ast.Name) and stmt.value is not None:
                    decls[targets[0].id] = (stmt.lineno, stmt.value)
        pure = {k: v for k, v in decls.items() if counts.get(k) == 1}

        def refs_ok(name):
            for n in ast.walk(fn):
                if not (isinstance(n, ast.Name) and n.id == name and isinstance(n.ctx, ast.Load)):
                    continue
                child = n
                ok = False
                for p in self.f.ancestors(n):
                    if isinstance(p, PURE_CONTAINERS) or (isinstance(p, ast.Subscript) and isinstance(p.ctx, ast.Load)):
                        child = p
                        continue
                    if isinstance(p, ast.Assert) and child is p.test:
                        ok = True
                    elif isinstance(p, (ast.Assign, ast.AnnAssign)) and child is p.value:
                        tg = p.targets if isinstance(p, ast.Assign) else [p.target]
                        ok = len(tg) == 1 and isinstance(tg[0], ast.Name) and tg[0].id in pure
                    elif isinstance(p, ast.Call) and child in p.args and isinstance(p.func, ast.Attribute) \
                            and isinstance(p.func.value, ast.Name) and p.func.value.id == "self" and p.func.attr in UNITTEST_KINDS:
                        ok = True
                    break
                if not ok:
                    return False
            return True

        changed = True
        while changed:
            changed = False
            for name in list(pure):
                if is_pure(pure[name][1], pure) and refs_ok(name):
                    continue
                del pure[name]
                changed = True
        return pure

    # --- tests -----------------------------------------------------------------------------

    def scan_test(self, fn):
        self.aliases = {}
        for n in ast.walk(fn):
            if isinstance(n, ast.Assign) and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name):
                v = n.value.value if isinstance(n.value, ast.Await) else n.value
                if isinstance(v, ast.Call):
                    self.aliases[n.targets[0].id] = text(v.func)
        pure = self.own_literal_bindings(fn)
        assertions = []
        helpers = 0

        def visit(n):
            nonlocal helpers
            if isinstance(n, ast.Assert):
                if self.always_false(n.test):
                    helpers += 1  # `assert False, "unreachable"` is a fail() call
                else:
                    assertions.append(self.assert_stmt(n, fn, pure))
            elif isinstance(n, ast.Call):
                r = self.call_assertion(n, fn, pure)
                if r == "helper":
                    helpers += 1
                elif r is not None:
                    assertions.append(r)
            for c in ast.iter_child_nodes(n):
                visit(c)

        for s in fn.body:
            visit(s)
        assertions.sort(key=lambda a: (a["line"], a["column"]))
        return assertions, helpers

    def decorator_modifier(self, decorators):
        for d in decorators:
            target = d.func if isinstance(d, ast.Call) else d
            name = dotted(target) or ""
            if name in ("pytest.mark.skip", "mark.skip", "unittest.skip", "skip"):
                return "skip"
        return None

    def body_skips(self, fn):
        """`pytest.skip(...)` / `self.skipTest(...)` as an unconditional first statement."""
        for s in fn.body:
            if isinstance(s, ast.Expr) and isinstance(s.value, ast.Constant) and isinstance(s.value.value, str):
                continue  # docstring
            if isinstance(s, ast.Expr) and isinstance(s.value, ast.Call):
                d = dotted(s.value.func) or ""
                return d in ("pytest.skip", "self.skipTest")
            return False
        return False

    def is_fixture(self, fn):
        for d in fn.decorator_list:
            target = d.func if isinstance(d, ast.Call) else d
            if (dotted(target) or "").endswith("fixture"):
                return True
        return False

    def make_case(self, node, kind, name, modifier):
        end = getattr(node, "end_lineno", node.lineno) or node.lineno
        return {
            "name": name,
            "kind": kind,
            "line": node.lineno,
            "endLine": end,
            "modifier": modifier,
            "headText": self.f.line_text(node.lineno, node.lineno),
            "analyzable": kind == "test",
            "assertions": [],
            "helperAssertionCalls": 0,
            "hasAssertionCountGuard": False,
            "mockSetups": [],
        }

    def is_test_class(self, cls, test_classes):
        if cls.name.startswith("Test"):
            return not any(isinstance(s, ast.FunctionDef) and s.name == "__init__" for s in cls.body)
        for b in cls.bases:
            bn = last_attr(b) or ""
            if bn.endswith("TestCase") or bn in test_classes:
                return True
        return False

    def collect(self, body, outer_mod, prefix, tests, file_setups, test_classes):
        for node in body:
            if isinstance(node, ast.ClassDef):
                if not self.is_test_class(node, test_classes):
                    continue
                test_classes.add(node.name)
                mod = self.decorator_modifier(node.decorator_list) or outer_mod
                tests.append(self.make_case(node, "suite", prefix + node.name, mod))
                # Like `describe.skip`, a skipped class is reported once; its methods aren't each re-reported.
                self.collect(node.body, None, prefix + node.name + "::", tests, file_setups, test_classes)
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name.startswith("test") and not self.is_fixture(node):
                mod = self.decorator_modifier(node.decorator_list) or outer_mod
                if mod is None and self.body_skips(node):
                    mod = "skip"
                tc = self.make_case(node, "test", prefix + node.name, mod)
                tc["assertions"], tc["helperAssertionCalls"] = self.scan_test(node)
                tc["mockSetups"] = file_setups + self.mock_setups(node, False)
                tests.append(tc)

    def run(self):
        self.scan_vocab()
        tree = self.f.tree
        file_setups = self.mock_setups(tree, True)
        tests = []
        self.collect(tree.body, None, "", tests, file_setups, set())
        return {
            "tests": tests,
            "moduleMocks": self.module_mocks(),
            "unitSpies": [],
        }


def support_helpers(sources):
    """Names of functions and methods in test-support code (conftest.py, tests/lib/...) whose bodies
    assert, so `result.did_create(path)` counts as an assertion in the tests that call it."""
    funcs = []
    for src in sources:
        try:
            tree = ast.parse(src)
        except (SyntaxError, ValueError, RecursionError):
            continue
        funcs += [n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]
    names = set()
    changed = True
    while changed:
        changed = False
        for fn in funcs:
            if fn.name in names or fn.name.startswith("__") or len(fn.name) < 4 or fn.name.startswith("test"):
                continue
            for n in ast.walk(fn):
                if isinstance(n, ast.Assert) or (isinstance(n, ast.Call) and last_attr(n.func) in names):
                    names.add(fn.name)
                    changed = True
                    break
    return frozenset(names)


def main():
    payload = json.load(sys.stdin)
    files = payload["files"]
    helpers = support_helpers(payload.get("support", []) + [f["source"] for f in files])
    out = []
    for item in files:
        try:
            out.append(Extractor(item["path"], item["source"], helpers).run())
        except SyntaxError as e:
            out.append({"error": "SyntaxError: %s (line %s)" % (e.msg, e.lineno)})
        except RecursionError:
            out.append({"error": "file too deeply nested to analyze"})
        except Exception as e:  # never let one file kill the batch
            out.append({"error": "%s: %s" % (type(e).__name__, e)})
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
