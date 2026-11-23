// Notepad++-style end-of-line markers ("CR LF" / "LF") for "Show All Characters".
// Monaco's renderWhitespace covers spaces and tabs; line endings are drawn here as
// injected text, only for the visible lines so huge files stay fast.
import { monaco } from "./monaco-setup";

export function installEolMarkers(editor: monaco.editor.IStandaloneCodeEditor, isEnabled: () => boolean) {
  const decorations = editor.createDecorationsCollection();
  let frame = 0;

  const update = () => {
    frame = 0;
    const model = editor.getModel();
    if (!model || !isEnabled()) {
      decorations.clear();
      return;
    }
    const label = model.getEOL() === "\r\n" ? "CRLF" : "LF";
    const lastLine = model.getLineCount();
    const items: monaco.editor.IModelDeltaDecoration[] = [];
    for (const range of editor.getVisibleRanges()) {
      const from = Math.max(1, range.startLineNumber - 20);
      const to = Math.min(lastLine - 1, range.endLineNumber + 20); // the last line has no line break
      for (let line = from; line <= to; line++) {
        const col = model.getLineMaxColumn(line);
        items.push({
          range: new monaco.Range(line, col, line, col),
          options: { after: { content: label, inlineClassName: "eol-marker" }, showIfCollapsed: true },
        });
      }
    }
    decorations.set(items);
  };

  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };
  editor.onDidScrollChange(schedule);
  editor.onDidChangeModel(schedule);
  editor.onDidChangeModelContent(schedule);
  editor.onDidLayoutChange(schedule);
  return schedule;
}
