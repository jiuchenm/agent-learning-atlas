// Preserve LaTeX before Markdown consumes punctuation escapes such as \| and \\.
export function protectMath(markdown) {
  const equations = [];
  const protectedText = markdown.replace(/\$\$([\s\S]+?)\$\$|(?<!\$)\$([^$\n]+)\$(?!\$)/g, (_, block, inline) => {
    const index = equations.push({tex:block ?? inline, display:!!block}) - 1;
    return '<span data-atlas-math="' + index + '"></span>';
  });
  return {protectedText, equations};
}
