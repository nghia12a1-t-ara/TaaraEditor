//! Symbol extraction for the workspace index (go to definition, workspace
//! symbols). A fast heuristic parser, tuned for C/C++ firmware code: no
//! compile_commands.json or language server needed.
//!
//! Compared to the editor's outline parser (src/symbols.ts) this one also
//! records object-like macros, enum members, global variables, struct fields
//! and prototypes, because those are what "go to definition" is used on.

use regex::Regex;
use serde::Serialize;
use std::sync::LazyLock;

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Function,
    Method,
    Prototype,
    Class,
    Struct,
    Enum,
    Union,
    Typedef,
    Macro,
    EnumMember,
    Variable,
    Field,
    Declaration,
    Namespace,
    Label,
    Trait,
    Module,
}

impl Kind {
    /// Declarations rank below definitions in "go to definition".
    pub fn is_declaration(self) -> bool {
        matches!(self, Kind::Prototype | Kind::Declaration | Kind::Field)
    }
}

#[derive(Serialize, Clone, Debug)]
pub struct Sym {
    pub name: String,
    pub kind: Kind,
    /// 1-based line; 1-based column in UTF-16 units (Monaco).
    pub line: u32,
    pub column: u32,
    /// Enclosing type for fields / enum members / methods.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub container: Option<String>,
}

/// Which parser to use for a file extension (lower-case, without dot).
pub fn parser_for(ext: &str) -> Option<fn(&str) -> Vec<Sym>> {
    Some(match ext {
        "c" | "h" | "cpp" | "cc" | "cxx" | "hpp" | "hh" | "hxx" | "inl" | "ino" | "ipp" | "tpp" => extract_c,
        "s" | "asm" => extract_asm,
        "py" | "pyw" => extract_python,
        "rs" => extract_rust,
        "js" | "mjs" | "cjs" | "jsx" | "ts" | "tsx" | "mts" => extract_js,
        _ => return None,
    })
}

// ------------------------------------------------------------------ positions

struct Positioner<'a> {
    text: &'a str,
    starts: Vec<usize>,
}

impl<'a> Positioner<'a> {
    fn new(text: &'a str) -> Self {
        let mut starts = vec![0];
        starts.extend(text.bytes().enumerate().filter(|(_, b)| *b == b'\n').map(|(i, _)| i + 1));
        Self { text, starts }
    }

    fn at(&self, offset: usize) -> (u32, u32) {
        let line = match self.starts.binary_search(&offset) {
            Ok(i) => i,
            Err(i) => i - 1,
        };
        let start = self.starts[line];
        let col = self.text.get(start..offset).map(|s| s.encode_utf16().count()).unwrap_or(offset - start);
        (line as u32 + 1, col as u32 + 1)
    }

    fn sym(&self, name: &str, kind: Kind, offset: usize, container: Option<&str>) -> Sym {
        let (line, column) = self.at(offset);
        Sym { name: name.to_string(), kind, line, column, container: container.map(str::to_string) }
    }
}

/// `&s[start..end]`, with `end` moved down to a char boundary.
fn slice_to(s: &str, start: usize, end: usize) -> &str {
    let mut end = end.min(s.len());
    while end > start && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[start..end]
}

fn is_ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

// ------------------------------------------------------------------ C / C++

struct Macro {
    name: String,
    offset: usize,
}

/// Blank out comments, string/char literals and preprocessor lines (keeping
/// byte offsets), and collect `#define` names.
fn strip_c(text: &str) -> (String, Vec<Macro>) {
    static DEFINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^#\s*define\s+([A-Za-z_]\w*)").unwrap());
    let bytes = text.as_bytes();
    let n = bytes.len();
    let mut out = bytes.to_vec();
    let mut macros = Vec::new();
    let blank = |out: &mut Vec<u8>, from: usize, to: usize| {
        for b in &mut out[from..to.min(n)] {
            if *b != b'\n' {
                *b = b' ';
            }
        }
    };
    let mut i = 0;
    let mut line_start = true;
    while i < n {
        let c = bytes[i];
        if c == b'\n' {
            line_start = true;
            i += 1;
            continue;
        }
        if line_start && c == b'#' {
            let mut j = i;
            while j < n && !(bytes[j] == b'\n' && (j == 0 || bytes[j - 1] != b'\\')) {
                j += 1;
            }
            if let Some(m) = DEFINE.captures(slice_to(text, i, j.min(i + 300))) {
                let g = m.get(1).unwrap();
                macros.push(Macro { name: g.as_str().to_string(), offset: i + g.start() });
            }
            blank(&mut out, i, j);
            i = j;
            continue;
        }
        if c != b' ' && c != b'\t' && c != b'\r' {
            line_start = false;
        }
        if c == b'/' && i + 1 < n && bytes[i + 1] == b'/' {
            let mut j = i;
            while j < n && bytes[j] != b'\n' {
                j += 1;
            }
            blank(&mut out, i, j);
            i = j;
        } else if c == b'/' && i + 1 < n && bytes[i + 1] == b'*' {
            let j = text[i + 2..].find("*/").map(|p| i + 2 + p + 2).unwrap_or(n);
            blank(&mut out, i, j);
            i = j;
        } else if c == b'"' || c == b'\'' {
            let mut j = i + 1;
            while j < n && bytes[j] != c && bytes[j] != b'\n' {
                j += if bytes[j] == b'\\' { 2 } else { 1 };
            }
            blank(&mut out, i + 1, j.min(n));
            i = j + 1;
        } else {
            i += 1;
        }
    }
    // Only ASCII bytes were replaced, by ASCII spaces, so this stays valid UTF-8
    // except when a multi-byte char was partially blanked; fall back to lossy.
    let code = String::from_utf8(out).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned());
    (code, macros)
}

const NOT_FUNCTIONS: &[&str] = &[
    "if", "for", "while", "switch", "catch", "return", "sizeof", "defined", "alignas", "decltype", "__attribute__",
    "__declspec", "do", "else", "typeof", "__typeof__", "_Static_assert", "static_assert", "__asm", "__asm__", "asm",
];

fn strip_trailing_qualifiers(mut h: &str) -> &str {
    loop {
        let t = h.trim_end();
        let mut changed = false;
        for q in ["const", "noexcept", "override", "final", "volatile", "mutable"] {
            if let Some(rest) = t.strip_suffix(q) {
                if !rest.as_bytes().last().is_some_and(|b| is_ident_byte(*b)) {
                    h = rest;
                    changed = true;
                }
            }
        }
        if !changed {
            return t;
        }
    }
}

/// If `head` (text before `{` or `;`) ends like a function signature, return
/// the function name and its byte offset within `head`.
fn function_head(head: &str) -> Option<(String, usize)> {
    static TRAILING_RET: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s*->\s*[\w:<>,*&\s]+$").unwrap());
    static NAME: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(~?[A-Za-z_]\w*(?:\s*::\s*~?[A-Za-z_]\w*)*|operator\s*\S+)\s*$").unwrap());
    static RETURN_END: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\breturn\s*$").unwrap());

    let mut h = strip_trailing_qualifiers(head);
    if let Some(m) = TRAILING_RET.find(h) {
        h = &h[..m.start()];
    }
    // Constructor initializer list: "Foo::Foo(int a) : m(a), n(b)".
    let b = h.as_bytes();
    for i in 0..b.len() {
        if b[i] == b')' {
            let mut j = i + 1;
            while j < b.len() && b[j].is_ascii_whitespace() {
                j += 1;
            }
            if j < b.len() && b[j] == b':' && b.get(j + 1) != Some(&b':') {
                h = &h[..=i];
                break;
            }
        }
    }
    if !h.ends_with(')') {
        return None;
    }
    let b = h.as_bytes();
    let mut depth = 0i32;
    let mut k = b.len();
    while k > 0 {
        k -= 1;
        match b[k] {
            b')' => depth += 1,
            b'(' => {
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
            _ => {}
        }
    }
    if k == 0 || depth != 0 {
        return None;
    }
    let before = &h[..k];
    let m = NAME.captures(before)?;
    let g = m.get(1)?;
    let name: String = g.as_str().chars().filter(|c| !c.is_whitespace()).collect();
    let last = name.rsplit("::").next().unwrap_or(&name);
    if NOT_FUNCTIONS.contains(&last) {
        return None;
    }
    let prefix = before[..g.start()].trim_end();
    if prefix.ends_with(['=', ',', '(']) || RETURN_END.is_match(prefix) {
        return None;
    }
    Some((name, g.start()))
}

/// Name declared by a variable/field/typedef declaration (text before `;`).
fn declarator(head: &str) -> Option<(String, usize)> {
    static FN_PTR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\(\s*\*\s*(?:const\s+)?([A-Za-z_]\w*)\s*(?:\[[^\]]*\]\s*)*\)\s*\(").unwrap());
    static LAST: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"[\w*&\s>]\s*\b([A-Za-z_]\w*)\s*(?:\[[^\]]*\]\s*)*(?::\s*\d+\s*)?$").unwrap());
    // Function pointers: "void (*handler)(int)".
    if let Some(m) = FN_PTR.captures(head) {
        let g = m.get(1)?;
        return Some((g.as_str().to_string(), g.start()));
    }
    // Cut at the first top-level '=' or ',' (only the first declarator).
    let b = head.as_bytes();
    let mut depth = 0i32;
    let mut end = b.len();
    for (i, &c) in b.iter().enumerate() {
        match c {
            b'(' | b'[' | b'{' | b'<' => depth += 1,
            b')' | b']' | b'}' | b'>' => depth -= 1,
            b'=' | b',' if depth <= 0 => {
                end = i;
                break;
            }
            _ => {}
        }
    }
    let left = &head[..end];
    if left.contains('(') {
        return None;
    }
    let m = LAST.captures(left)?;
    let g = m.get(1)?;
    const KEYWORDS: &[&str] = &[
        "int", "char", "short", "long", "float", "double", "void", "unsigned", "signed", "const", "volatile", "static",
        "struct", "union", "enum", "class", "public", "private", "protected", "return", "break", "continue", "goto",
        "default", "case", "inline", "extern", "register", "auto", "bool", "typedef",
    ];
    if KEYWORDS.contains(&g.as_str()) {
        return None;
    }
    // There must be a type before the name ("x;" alone is an expression).
    if left[..g.start()].trim().is_empty() {
        return None;
    }
    Some((g.as_str().to_string(), g.start()))
}

#[derive(Clone, Copy, PartialEq)]
enum BlockKind {
    Func,
    Type,     // struct/class/union with a name (members are fields)
    Enum,     // enum body (members are enum constants)
    Typedef,  // anonymous typedef struct/union: name comes after '}'
    Other,    // namespace, extern "C", initializers...
}

struct Block {
    kind: BlockKind,
    open: usize,
    /// Type name (for fields / enum members / methods).
    name: Option<String>,
    /// `typedef struct {...} Name;`: read the alias after the closing brace.
    typedef_alias: bool,
}

pub fn extract_c(text: &str) -> Vec<Sym> {
    static TYPE_HEAD: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"\b(typedef\s+)?(struct|class|union|enum|namespace)(?:\s+class)?\s*(?:__attribute__\s*\(\([^)]*\)\)\s*)?([A-Za-z_]\w*)?\s*(?::[^{;]*)?$").unwrap()
    });
    static AFTER_BRACE_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*(?:__attribute__\s*\(\([^)]*\)\)\s*)?\*?\s*([A-Za-z_]\w*)").unwrap());
    static ENUM_ITEM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*([A-Za-z_]\w*)\s*(?:=|$)").unwrap());

    let (code, macros) = strip_c(text);
    let pos = Positioner::new(text);
    let mut syms: Vec<Sym> = macros.iter().map(|m| pos.sym(&m.name, Kind::Macro, m.offset, None)).collect();
    let mut stack: Vec<Block> = Vec::new();
    let mut stmt_start = 0usize;
    let b = code.as_bytes();

    let in_func = |stack: &Vec<Block>| stack.iter().any(|b| b.kind == BlockKind::Func);

    for i in 0..b.len() {
        match b[i] {
            b';' => {
                if !in_func(&stack) {
                    let head = &code[stmt_start..i];
                    let trimmed = head.trim_start();
                    let lead = head.len() - trimmed.len();
                    let top = stack.last();
                    let container = top.and_then(|t| t.name.clone());
                    let in_type = top.is_some_and(|t| t.kind == BlockKind::Type || t.kind == BlockKind::Typedef);
                    if top.is_some_and(|t| t.kind == BlockKind::Enum) {
                        // handled when the enum closes
                    } else if trimmed.starts_with("typedef") {
                        if let Some((name, off)) = declarator(trimmed) {
                            syms.push(pos.sym(&name, Kind::Typedef, stmt_start + lead + off, None));
                        }
                    } else if trimmed.starts_with("using ") || trimmed.starts_with("return") || trimmed.starts_with("friend ") {
                    } else if let Some((name, off)) = function_head(trimmed) {
                        if !trimmed.contains('=') || in_type {
                            syms.push(pos.sym(&name, Kind::Prototype, stmt_start + lead + off, container.as_deref()));
                        }
                    } else if let Some((name, off)) = declarator(trimmed) {
                        let kind = if in_type {
                            Kind::Field
                        } else if trimmed.starts_with("extern") {
                            Kind::Declaration
                        } else {
                            Kind::Variable
                        };
                        syms.push(pos.sym(&name, kind, stmt_start + lead + off, if in_type { container.as_deref() } else { None }));
                    }
                }
                stmt_start = i + 1;
            }
            b'{' => {
                let head = &code[stmt_start..i];
                let mut block = Block { kind: BlockKind::Other, open: i, name: None, typedef_alias: false };
                if !in_func(&stack) && !stack.last().is_some_and(|t| t.kind == BlockKind::Enum) {
                    if let Some(m) = TYPE_HEAD.captures(head) {
                        let kw = m.get(2).unwrap().as_str();
                        let is_typedef = m.get(1).is_some();
                        let kind = match kw {
                            "class" => Kind::Class,
                            "union" => Kind::Union,
                            "enum" => Kind::Enum,
                            "namespace" => Kind::Namespace,
                            _ => Kind::Struct,
                        };
                        if let Some(n) = m.get(3) {
                            syms.push(pos.sym(n.as_str(), kind, stmt_start + n.start(), None));
                            block.name = Some(n.as_str().to_string());
                        }
                        block.typedef_alias = is_typedef;
                        block.kind = match kw {
                            "namespace" => BlockKind::Other,
                            "enum" => BlockKind::Enum,
                            _ if is_typedef && block.name.is_none() => BlockKind::Typedef,
                            _ => BlockKind::Type,
                        };
                    } else if let Some((name, off)) = function_head(head) {
                        let container = stack.iter().rev().find(|b| b.kind == BlockKind::Type).and_then(|b| b.name.clone());
                        let kind = if name.contains("::") || container.is_some() { Kind::Method } else { Kind::Function };
                        syms.push(pos.sym(&name, kind, stmt_start + off, container.as_deref()));
                        block.kind = BlockKind::Func;
                    } else if head.contains('=') {
                        // Initializer: "static Led_t led = {0};", "int table[] = {1, 2};"
                        let trimmed = head.trim_start();
                        let lead = head.len() - trimmed.len();
                        if let Some((name, off)) = declarator(trimmed) {
                            syms.push(pos.sym(&name, Kind::Variable, stmt_start + lead + off, None));
                        }
                    }
                }
                stack.push(block);
                stmt_start = i + 1;
            }
            b'}' => {
                if let Some(block) = stack.pop() {
                    let type_name = block.name.clone();
                    // typedef struct {...} Name_t;  /  typedef enum {...} Name_t;
                    let mut alias = None;
                    if block.typedef_alias {
                        if let Some(m) = AFTER_BRACE_NAME.captures(slice_to(&code, i + 1, i + 300)) {
                            let g = m.get(1).unwrap();
                            syms.push(pos.sym(g.as_str(), Kind::Typedef, i + 1 + g.start(), None));
                            alias = Some(g.as_str().to_string());
                        }
                    }
                    if block.kind == BlockKind::Enum {
                        let container = type_name.or(alias);
                        let body = &code[block.open + 1..i];
                        let mut depth = 0i32;
                        let mut item_start = 0usize;
                        let bb = body.as_bytes();
                        for k in 0..=bb.len() {
                            let at_end = k == bb.len();
                            let c = if at_end { b',' } else { bb[k] };
                            match c {
                                b'(' | b'{' | b'[' => depth += 1,
                                b')' | b'}' | b']' => depth -= 1,
                                b',' if depth == 0 => {
                                    let item = &body[item_start..k];
                                    if let Some(m) = ENUM_ITEM.captures(item.trim_end()) {
                                        let g = m.get(1).unwrap();
                                        syms.push(pos.sym(g.as_str(), Kind::EnumMember, block.open + 1 + item_start + g.start(), container.as_deref()));
                                    }
                                    item_start = k + 1;
                                }
                                _ => {}
                            }
                        }
                    }
                }
                stmt_start = i + 1;
            }
            _ => {}
        }
    }
    syms.sort_by_key(|s| (s.line, s.column));
    syms
}

// ------------------------------------------------------------------ other languages

fn by_regex(text: &str, re: &Regex, f: impl Fn(&regex::Captures) -> Option<(usize, Kind)>) -> Vec<Sym> {
    let pos = Positioner::new(text);
    re.captures_iter(text)
        .filter_map(|c| {
            let (group, kind) = f(&c)?;
            let g = c.get(group)?;
            Some(pos.sym(g.as_str(), kind, g.start(), None))
        })
        .collect()
}

pub fn extract_asm(text: &str) -> Vec<Sym> {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^([A-Za-z_.$][\w.$]*):|^\s*\.(?:equ|set)\s+([A-Za-z_]\w*)").unwrap());
    let pos = Positioner::new(text);
    RE.captures_iter(text)
        .filter_map(|c| {
            if let Some(l) = c.get(1) {
                (!l.as_str().starts_with(".L")).then(|| pos.sym(l.as_str(), Kind::Label, l.start(), None))
            } else {
                c.get(2).map(|g| pos.sym(g.as_str(), Kind::Macro, g.start(), None))
            }
        })
        .collect()
}

pub fn extract_python(text: &str) -> Vec<Sym> {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^([ \t]*)(?:async[ \t]+)?(def|class)[ \t]+([A-Za-z_]\w*)|^([A-Za-z_]\w*)[ \t]*(?::[^=\n]*)?=[^=]").unwrap());
    by_regex(text, &RE, |c| {
        if let Some(kw) = c.get(2) {
            let kind = if kw.as_str() == "class" { Kind::Class } else if c.get(1).is_some_and(|i| !i.as_str().is_empty()) { Kind::Method } else { Kind::Function };
            Some((3, kind))
        } else {
            Some((4, Kind::Variable))
        }
    })
}

pub fn extract_rust(text: &str) -> Vec<Sym> {
    static RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"(?m)^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?(?:(?:const|async|unsafe|extern[ \t]+"[^"]*")[ \t]+)*(fn|struct|enum|trait|mod|union|type|const|static|macro_rules!)[ \t]*(?:mut[ \t]+)?([A-Za-z_]\w*)"#).unwrap()
    });
    by_regex(text, &RE, |c| {
        let kind = match c.get(1)?.as_str() {
            "fn" => Kind::Function,
            "struct" => Kind::Struct,
            "enum" => Kind::Enum,
            "trait" => Kind::Trait,
            "mod" => Kind::Module,
            "union" => Kind::Union,
            "type" => Kind::Typedef,
            "macro_rules!" => Kind::Macro,
            _ => Kind::Variable,
        };
        Some((2, kind))
    })
}

pub fn extract_js(text: &str) -> Vec<Sym> {
    static RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?m)^[ \t]*(?:export[ \t]+)?(?:default[ \t]+)?(?:(?:async[ \t]+)?function\*?[ \t]+([A-Za-z_$][\w$]*)|(class|interface|type|enum)[ \t]+([A-Za-z_$][\w$]*)|(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*))").unwrap()
    });
    by_regex(text, &RE, |c| {
        if c.get(1).is_some() {
            Some((1, Kind::Function))
        } else if let Some(kw) = c.get(2) {
            Some((3, match kw.as_str() { "class" => Kind::Class, "enum" => Kind::Enum, _ => Kind::Typedef }))
        } else {
            Some((4, Kind::Variable))
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn find<'a>(syms: &'a [Sym], name: &str) -> Vec<&'a Sym> {
        syms.iter().filter(|s| s.name == name).collect()
    }

    const FIRMWARE: &str = r#"#include "main.h"
#define BLINK_MS 500
#define MAX(a, b) ((a) > (b) ? (a) : (b))
/* void fake(void) { } */
typedef enum
{
  HAL_OK       = 0x00U,
  HAL_ERROR    = 0x01U,
  HAL_BUSY
} HAL_StatusTypeDef;

typedef struct {
  volatile uint32_t CR;   // "{"
  uint32_t ARR[4];
  void (*Callback)(int);
} TIM_TypeDef;

struct Point { int x, y; };
typedef void (*irq_handler_t)(void);
typedef unsigned int u32;
extern uint32_t SystemCoreClock;
static const char *msg = "int bogus(void) {";
static Led_t led = {0};
uint8_t rx_buf[64];
void HAL_Delay(uint32_t Delay);
HAL_StatusTypeDef HAL_Init(void);
__attribute__((weak)) void HardFault_Handler(void)
{
  int local = 1;
  while (1) { }
}
static void
SystemClock_Config(void) { if (x) { y(); } }
int main(void) { HAL_Init(); return 0; }
class Foo : public Bar {
public:
  Foo(int a) : m(a) {}
  int get() const;
  int m;
};
Foo::~Foo() {}
namespace hal { void init(int (*cb)(int)) { } }
"#;

    #[test]
    fn c_firmware_symbols() {
        let syms = extract_c(FIRMWARE);
        let kinds = |n: &str| find(&syms, n).iter().map(|s| s.kind).collect::<Vec<_>>();
        assert_eq!(kinds("BLINK_MS"), vec![Kind::Macro]);
        assert_eq!(kinds("MAX"), vec![Kind::Macro]);
        assert_eq!(kinds("HAL_OK"), vec![Kind::EnumMember]);
        assert_eq!(kinds("HAL_BUSY"), vec![Kind::EnumMember]);
        assert_eq!(find(&syms, "HAL_ERROR")[0].container.as_deref(), Some("HAL_StatusTypeDef"));
        assert_eq!(kinds("HAL_StatusTypeDef"), vec![Kind::Typedef]);
        assert_eq!(kinds("TIM_TypeDef"), vec![Kind::Typedef]);
        assert_eq!(kinds("CR"), vec![Kind::Field]);
        assert_eq!(kinds("ARR"), vec![Kind::Field]);
        assert_eq!(kinds("Callback"), vec![Kind::Field]);
        assert_eq!(kinds("Point"), vec![Kind::Struct]);
        assert_eq!(kinds("x"), vec![Kind::Field]);
        assert_eq!(kinds("irq_handler_t"), vec![Kind::Typedef]);
        assert_eq!(kinds("u32"), vec![Kind::Typedef]);
        assert_eq!(kinds("SystemCoreClock"), vec![Kind::Declaration]);
        assert_eq!(kinds("msg"), vec![Kind::Variable]);
        assert_eq!(kinds("led"), vec![Kind::Variable]);
        assert_eq!(kinds("rx_buf"), vec![Kind::Variable]);
        assert_eq!(kinds("HAL_Delay"), vec![Kind::Prototype]);
        assert_eq!(kinds("HAL_Init"), vec![Kind::Prototype]);
        assert_eq!(kinds("HardFault_Handler"), vec![Kind::Function]);
        assert_eq!(kinds("SystemClock_Config"), vec![Kind::Function]);
        assert_eq!(kinds("main"), vec![Kind::Function]);
        assert_eq!(kinds("Foo"), vec![Kind::Class, Kind::Method]);
        assert_eq!(kinds("get"), vec![Kind::Prototype]);
        assert_eq!(kinds("m"), vec![Kind::Field]);
        assert_eq!(kinds("Foo::~Foo"), vec![Kind::Method]);
        assert_eq!(kinds("hal"), vec![Kind::Namespace]);
        assert_eq!(kinds("init"), vec![Kind::Function]);
        // Nothing from comments, strings or function bodies.
        assert!(find(&syms, "fake").is_empty());
        assert!(find(&syms, "bogus").is_empty());
        assert!(find(&syms, "local").is_empty());
        assert!(find(&syms, "y").is_empty());
    }

    #[test]
    fn positions_are_utf16() {
        let syms = extract_c("// é😀\nint 😀x;\nint value;\n");
        let v = find(&syms, "value")[0];
        assert_eq!((v.line, v.column), (3, 5));
    }

    #[test]
    fn other_languages() {
        let asm = extract_asm("  .equ STACK_SIZE, 0x400\nReset_Handler:\n  bl main\n.L1:\n");
        assert_eq!(asm.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), vec!["STACK_SIZE", "Reset_Handler"]);
        let py = extract_python("BAUD = 115200\nclass A:\n    def f(self):\n        pass\n");
        assert_eq!(py.iter().map(|s| (s.name.as_str(), s.kind)).collect::<Vec<_>>(), vec![("BAUD", Kind::Variable), ("A", Kind::Class), ("f", Kind::Method)]);
        let rs = extract_rust("pub fn run() {}\nstatic mut COUNT: u32 = 0;\n");
        assert_eq!(rs.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), vec!["run", "COUNT"]);
    }
}
