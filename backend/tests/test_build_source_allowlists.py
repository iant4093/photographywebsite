"""Contract tests for per-function SAM build isolation."""

import ast
import re
import unittest
from pathlib import Path


BACKEND_ROOT = Path(__file__).resolve().parents[1]
FUNCTIONS_ROOT = BACKEND_ROOT / "functions"
MAKEFILE = BACKEND_ROOT / "Makefile"
TEMPLATE = BACKEND_ROOT / "template.yaml"


def _local_imports(path, local_modules):
    imports = set()
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imports.update(
                alias.name.split(".", 1)[0]
                for alias in node.names
                if alias.name.split(".", 1)[0] in local_modules
            )
        elif isinstance(node, ast.ImportFrom) and node.module:
            module = node.module.split(".", 1)[0]
            if module in local_modules:
                imports.add(module)
    return imports


class BuildSourceAllowlistTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.makefile_text = MAKEFILE.read_text(encoding="utf-8")
        cls.template_text = TEMPLATE.read_text(encoding="utf-8")
        cls.module_paths = {path.stem: path for path in FUNCTIONS_ROOT.glob("*.py")}
        cls.direct_imports = {
            name: _local_imports(path, cls.module_paths)
            for name, path in cls.module_paths.items()
        }
        cls.allowlists = {
            logical_id: set(value.split())
            for logical_id, value in re.findall(
                r"^SOURCES_([A-Za-z0-9]+)\s*:=\s*(.+)$",
                cls.makefile_text,
                flags=re.MULTILINE,
            )
        }

    def _python_function_handlers(self):
        logical_id = None
        for line in self.template_text.splitlines():
            resource_match = re.match(r"^  ([A-Za-z0-9]+Function):$", line)
            if resource_match:
                logical_id = resource_match.group(1)
                continue
            handler_match = re.match(r"^      Handler: ([A-Za-z0-9_]+)\.handler$", line)
            if handler_match and handler_match.group(1) in self.module_paths:
                yield logical_id, handler_match.group(1)

    def _transitive_sources(self, handler):
        modules = {handler}
        pending = [handler]
        while pending:
            module = pending.pop()
            for dependency in self.direct_imports[module]:
                if dependency not in modules:
                    modules.add(dependency)
                    pending.append(dependency)
        return {f"{module}.py" for module in modules}

    def test_every_python_lambda_has_an_exact_transitive_source_allowlist(self):
        handlers = dict(self._python_function_handlers())
        self.assertTrue(handlers)
        self.assertEqual(set(handlers), set(self.allowlists))
        for logical_id, handler in handlers.items():
            with self.subTest(function=logical_id):
                self.assertEqual(
                    self._transitive_sources(handler),
                    self.allowlists[logical_id],
                )

    def test_allowlists_contain_only_existing_plain_python_filenames(self):
        for logical_id, sources in self.allowlists.items():
            with self.subTest(function=logical_id):
                self.assertTrue(sources)
                for source in sources:
                    self.assertRegex(source, r"^[A-Za-z0-9_]+\.py$")
                    self.assertTrue((FUNCTIONS_ROOT / source).is_file())

    def test_build_has_no_copy_all_fallback(self):
        self.assertNotIn("cp functions/*.py", self.makefile_text)
        self.assertIn("no explicit Python source allowlist exists", self.makefile_text)


if __name__ == "__main__":
    unittest.main()
