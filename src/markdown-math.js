// Preserve LaTeX before Markdown consumes escapes, keeping code spans literal.
export function protectMath(markdown) {
  const equations = [];
  // Scan original text in order: a code region protects its dollars; a math
  // region protects its TeX, including backticks and indented lines within it.
  // Do not lex Markdown first: that would split LaTeX escapes and code-looking
  // text inside formulas before we can preserve the original source.
  const regions = /^[ \t]*(?:(?:[-+*]|\d+[.)])[ \t]+)?(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[`~]*[ \t]*(?:\n|$)|(?![\s\S]))|^(?: {4,}|\t)[^\n]*(?:\n(?: {4,}|\t)[^\n]*)*|(`+)[\s\S]*?\2|\$\$([\s\S]+?)\$\$|(?<![$\\])\$([^$\n]+)\$(?!\$)/gm;
  const protectedText = markdown.replace(regions, (raw, fence, ticks, block, inline) => {
    if (block === undefined && inline === undefined) return raw;
    const index = equations.push({tex:block ?? inline, display:!!block}) - 1;
    return '<span data-atlas-math="' + index + '"></span>';
  });
  return {protectedText, equations};
}
