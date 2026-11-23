// Minimal JSONC parser (comments + trailing commas), as used by VS Code
// theme, snippet and language-configuration files.

export function parseJsonc<T = any>(text: string): T {
  let out = "";
  let i = 0;
  const n = text.length;
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  while (i < n) {
    const ch = text[i];
    if (ch === '"') {
      const start = i++;
      while (i < n && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      out += text.slice(start, ++i);
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
    } else if (ch === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      i = i < 0 ? n : i + 2;
    } else if (ch === ",") {
      // Drop the comma if the next significant char closes an object/array.
      let j = i + 1;
      for (;;) {
        while (j < n && /\s/.test(text[j])) j++;
        if (text[j] === "/" && text[j + 1] === "/") {
          while (j < n && text[j] !== "\n") j++;
        } else if (text[j] === "/" && text[j + 1] === "*") {
          const e = text.indexOf("*/", j + 2);
          j = e < 0 ? n : e + 2;
        } else break;
      }
      if (text[j] !== "}" && text[j] !== "]") out += ch;
      i++;
    } else {
      out += ch;
      i++;
    }
  }
  return JSON.parse(out);
}
