/**
 * Unit tests for the Google Docs -> Tiptap converter (master plan section 31).
 *
 * Pure, so it needs no server, but it lives beside the other suites so
 * `npm test` picks it up automatically.
 */
import { docsToTiptap, isGoogleDoc, toPlainText } from "../services/google.docs.js";

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
  if (!ok) {
    console.log(`     actual:   ${JSON.stringify(actual)}`);
    console.log(`     expected: ${JSON.stringify(expected)}`);
    failures += 1;
  }
};

const para = (text, style) => ({
  paragraph: {
    paragraphStyle: style ? { namedStyleType: style } : undefined,
    elements: [{ textRun: { content: text, textStyle: { weightedFontFamily: {} } } }],
  },
});

const paraWith = (elements, style) => ({
  paragraph: {
    paragraphStyle: style ? { namedStyleType: style } : undefined,
    elements,
  },
});

const run = (content, textStyle) => ({ textRun: { content, textStyle } });

// --- basic structure ---
const basic = docsToTiptap({
  title: "Project Proposal",
  body: {
    content: [
      para("Project Proposal", "TITLE"),
      para("A short summary of the work.", "NORMAL_TEXT"),
      para("The budget is fixed.", "NORMAL_TEXT"),
    ],
  },
});

check("title is read", basic.title, "Project Proposal");
check("content is a doc", basic.content.type, "doc");
check("title becomes an h1", basic.content.content[0].type, "heading");
check("h1 level is 1", basic.content.content[0].attrs, { level: 1 });
check("normal text becomes a paragraph", basic.content.content[1].type, "paragraph");
check("block count", basic.content.content.length, 3);
check("text survives", basic.content.content[1].content[0].text, "A short summary of the work.");
check("plain text is flattened", basic.plainText.includes("The budget is fixed."), true);
check("no limitations for plain text", basic.limitations, []);

// --- headings ---
const headings = docsToTiptap({
  title: "H",
  body: {
    content: [para("H2", "HEADING_2"), para("H3", "HEADING_3"), para("H6", "HEADING_6")],
  },
});
check("h2 level", headings.content.content[0].attrs, { level: 2 });
check("h3 level", headings.content.content[1].attrs, { level: 3 });
check("h6 level", headings.content.content[2].attrs, { level: 6 });

// --- marks ---
const marked = docsToTiptap({
  title: "M",
  body: { content: [paraWith([run("bold bit", { bold: true }), run(" and "), run("italic bit", { italic: true })])] },
});
const marks = marked.content.content[0].content;
check("bold run keeps one mark", marks[0].marks, [{ type: "bold" }]);
check("plain run has no marks", marks[1].marks, undefined);
check("italic run keeps one mark", marks[2].marks, [{ type: "italic" }]);
check("adjacent same-mark runs are not duplicated", JSON.stringify(marked).includes('{"type":"bold"},{"type":"bold"}'), false);

// --- links and colour ---
const linked = docsToTiptap({
  title: "L",
  body: { content: [paraWith([run("see here", { link: { url: "https://example.com", textStyle: { underline: true } } })])] },
});
check("link mark is kept", linked.content.content[0].content[0].marks[0], {
  type: "link",
  attrs: { href: "https://example.com" },
});

const coloured = docsToTiptap({
  title: "C",
  body: { content: [paraWith([run("blue text", { foregroundColor: { color: { rgbColor: { red: 0, green: 0.33, blue: 0.67 } } } })])] },
});
check("colour converts to hex", coloured.content.content[0].content[0].marks[0], {
  type: "textStyle",
  attrs: { color: "#0054ab" },
});

const red = docsToTiptap({
  title: "R",
  body: { content: [paraWith([run("deleted", { foregroundColor: { color: { rgbColor: { red: 1, green: 0, blue: 0 } } } })])] },
});
check("red text is not coloured", red.content.content[0].content[0].marks, undefined);
check("red text reports a limitation", red.limitations.length > 0, true);

// --- lists, machine-readable style ---
const bullets = docsToTiptap({
  title: "B",
  body: {
    content: [
      para("first item", "BULLETED_LIST"),
      para("second item", "BULLETED_LIST"),
      para("third item", "BULLETED_LIST"),
    ],
  },
});
check("bullets merge into one list", bullets.content.content.length, 1);
check("list type", bullets.content.content[0].type, "bulletList");
check("items merged", bullets.content.content[0].content.length, 3);
check("item type", bullets.content.content[0].content[0].type, "listItem");
check("item text", bullets.content.content[0].content[0].content[0].text, "first item");

const numbers = docsToTiptap({
  title: "N",
  body: { content: [para("one", "NUMBERED_LIST"), para("two", "NUMBERED_LIST")] },
});
check("numbered list type", numbers.content.content[0].type, "orderedList");
check("numbered items merged", numbers.content.content[0].content.length, 2);

// --- lists, glyph-detected fallback ---
const glyphs = docsToTiptap({
  title: "G",
  body: { content: [para("● alpha"), para("● beta")] },
});
check("glyph list detected", glyphs.content.content[0].type, "bulletList");
check("glyph stripped from text", glyphs.content.content[0].content[0].content[0].text, "alpha");
check("second glyph stripped", glyphs.content.content[0].content[1].content[0].text, "beta");

const glyphNumbers = docsToTiptap({
  title: "G2",
  body: { content: [para("1. first"), para("2. second")] },
});
check("numbered glyph detected", glyphNumbers.content.content[0].type, "orderedList");
check("numbered glyph stripped", glyphNumbers.content.content[0].content[0].content[0].text, "first");

// --- lists do not merge with paragraphs or with each other ---
const mixed = docsToTiptap({
  title: "M2",
  body: {
    content: [
      para("intro", "NORMAL_TEXT"),
      para("a", "BULLETED_LIST"),
      para("b", "BULLETED_LIST"),
      para("outro", "NORMAL_TEXT"),
      para("c", "BULLETED_LIST"),
    ],
  },
});
check("paragraph before list", mixed.content.content[0].type, "paragraph");
check("list of two", mixed.content.content[1].content.length, 2);
check("paragraph after list", mixed.content.content[2].type, "paragraph");
check("separate list is not merged", mixed.content.content[3].content.length, 1);

// --- empty and edge cases ---
const empty = docsToTiptap({ title: "Empty" });
check("empty doc still has a paragraph", empty.content.content.length, 1);
check("empty paragraph type", empty.content.content[0].type, "paragraph");
check("empty doc has no limitations", empty.limitations, []);

const blankParagraph = docsToTiptap({ title: "B2", body: { content: [para("")] } });
check("blank paragraph kept", blankParagraph.content.content[0].type, "paragraph");
check("blank paragraph has no content", blankParagraph.content.content[0].content, undefined);

check("no body key is safe", docsToTiptap({}).content.type, "doc");
check("null body is safe", docsToTiptap({ title: "x", body: null }).content.type, "doc");

// --- dropped constructs are reported, not silent ---
const withFootnote = docsToTiptap({
  title: "F",
  body: { content: [paraWith([run("text "), { footnoteReference: { footnoteId: "x" } }])] },
});
check("footnote dropped from text", withFootnote.content.content[0].content.length, 1);
check("footnote reported", withFootnote.limitations.some((l) => /[Ff]ootnote/.test(l)), true);

const withRule = docsToTiptap({
  title: "HR",
  body: { content: [paraWith([run("a"), { horizontalRule: {} }])] },
});
check("horizontal rule reported", withRule.limitations.some((l) => /[Hh]orizontal rule/.test(l)), true);

const withImage = docsToTiptap({
  title: "I",
  body: { content: [paraWith([{ inlineObjectElement: { inlineObjectProperties: { embeddedObject: { imageProperties: { contentUri: "x" } } } } }])] },
});
check("image reported", withImage.limitations.some((l) => /[Ii]mages/.test(l)), true);

const withSection = docsToTiptap({
  title: "S",
  body: { content: [{ sectionBreak: { sectionStyle: { columnProperties: {} } } }, para("after")] },
});
check("section break reported", withSection.limitations.some((l) => /[Ss]ection/.test(l)), true);
check("text after a section break survives", withSection.content.content.length, 1);

const withTable = docsToTiptap({
  title: "TB",
  body: { content: [paraWith([run("before"), { table: { rows: 2, columns: 2 } }, run("after")])] },
});
check("table reported", withTable.limitations.some((l) => /[Tt]able/.test(l)), true);
check("table text kept", withTable.plainText.includes("before"), true);

const withChip = docsToTiptap({
  title: "P",
  body: { content: [paraWith([{ person: { personProperties: { name: "Sara" } } }])] },
});
check("person chip becomes a name", withChip.content.content[0].content[0].text, "Sara");
check("person chip reported", withChip.limitations.some((l) => /[Pp]eople/.test(l)), true);

// --- trailing Docs line break is removed ---
const trailing = docsToTiptap({ title: "T", body: { content: [para("hello\n")] } });
check("trailing newline removed", trailing.content.content[0].content[0].text, "hello");

// --- helpers ---
check("plain text flattens lists", toPlainText({ type: "doc", content: [{ type: "bulletList", content: [{ type: "listItem", content: [{ type: "text", text: "x" }] }] }] }), "x");
check("plain text of nothing", toPlainText(undefined), "");
check("google doc mime detected", isGoogleDoc("application/vnd.google-apps.document"), true);
check("binary doc not detected", isGoogleDoc("application/vnd.openxmlformats-officedocument.wordprocessingml.document"), false);

console.log(failures === 0 ? "\nALL DOCS CONVERTER CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
if (failures) process.exit(1);
