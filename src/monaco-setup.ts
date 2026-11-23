// Monaco with all editor features but only the languages we need, to keep the
// bundle small. Extra languages come from VS Code extensions (.vsix).
import "monaco-editor/esm/vs/editor/edcore.main.js";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";

import "monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution.js";
import "monaco-editor/esm/vs/basic-languages/python/python.contribution.js";
import "monaco-editor/esm/vs/basic-languages/rust/rust.contribution.js";
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js";
import "monaco-editor/esm/vs/basic-languages/ini/ini.contribution.js";
import "monaco-editor/esm/vs/basic-languages/shell/shell.contribution.js";
import "monaco-editor/esm/vs/basic-languages/bat/bat.contribution.js";
import "monaco-editor/esm/vs/basic-languages/powershell/powershell.contribution.js";
import "monaco-editor/esm/vs/basic-languages/xml/xml.contribution.js";
import "monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution.js";
import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js";
import "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js";
import "monaco-editor/esm/vs/basic-languages/html/html.contribution.js";
import "monaco-editor/esm/vs/basic-languages/css/css.contribution.js";
import "monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile.contribution.js";
import "monaco-editor/esm/vs/basic-languages/mips/mips.contribution.js";
import "monaco-editor/esm/vs/basic-languages/systemverilog/systemverilog.contribution.js";
import "monaco-editor/esm/vs/language/json/monaco.contribution.js";

import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker.js?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker.js?worker";

(self as any).MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    return label === "json" ? new JsonWorker() : new EditorWorker();
  },
};

// Common embedded file types that Monaco doesn't map out of the box.
monaco.languages.register({ id: "makefile", extensions: [".mk", ".mak"], filenames: ["Makefile", "makefile", "GNUmakefile"], aliases: ["Makefile"] });
monaco.languages.register({ id: "cmake", extensions: [".cmake"], filenames: ["CMakeLists.txt"], aliases: ["CMake"] });
monaco.languages.register({ id: "linkerscript", extensions: [".ld", ".lds"], aliases: ["Linker Script"] });
monaco.languages.register({ id: "asm", extensions: [".s", ".S", ".asm", ".inc"], aliases: ["Assembly"] });
monaco.languages.register({ id: "plaintext", extensions: [".txt", ".log"], aliases: ["Plain Text"] });
monaco.languages.setLanguageConfiguration("linkerscript", { comments: { blockComment: ["/*", "*/"] } });
monaco.languages.setLanguageConfiguration("asm", { comments: { lineComment: "@", blockComment: ["/*", "*/"] } });
monaco.languages.setLanguageConfiguration("makefile", { comments: { lineComment: "#" } });
monaco.languages.setLanguageConfiguration("cmake", { comments: { lineComment: "#" } });

/** Find the Monaco language id for a file path (extension/filename match). */
export function languageForPath(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const lower = name.toLowerCase();
  let best: { id: string; len: number } | null = null;
  for (const lang of monaco.languages.getLanguages()) {
    if (lang.filenames?.some((f) => f.toLowerCase() === lower)) return lang.id;
    for (const ext of lang.extensions ?? []) {
      if (name.endsWith(ext) || lower.endsWith(ext.toLowerCase())) {
        // Longest extension wins; on ties the later registration (e.g. a .vsix) wins.
        if (!best || ext.length >= best.len) best = { id: lang.id, len: ext.length };
      }
    }
  }
  return best?.id ?? "plaintext";
}

export function languageName(id: string): string {
  const lang = monaco.languages.getLanguages().find((l) => l.id === id);
  return lang?.aliases?.[0] ?? id;
}

export { monaco };
