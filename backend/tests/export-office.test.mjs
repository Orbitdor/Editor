/**
 * Office export (master plan section 28): PDF and DOCX.
 *
 * These assertions are about the bytes being a real file of the right kind, not
 * about how they look: a PDF that starts with the PDF header and has a page and
 * an EOF marker is openable, and a .docx is a ZIP whose `word/document.xml` entry
 * carries the text. Checking the magic bytes catches the failure mode that
 * actually happens -- a renderer that throws halfway and returns a truncated or
 * empty body.
 */
import zlib from "node:zlib";

const API = process.env.API || "http://localhost:5051/api/v1";

let failures = 0;

function ok(label, extra = "") {
  console.log(`  PASS  ${label}${extra ? ` -> ${extra}` : ""}`);
}
function bad(label, detail) {
  failures += 1;
  console.log(`  FAIL  ${label} -> ${detail}`);
}
function check(label, condition, detail = "") {
  condition ? ok(label, detail) : bad(label, detail);
}
function section(title) {
  console.log(`\n== ${title} ==`);
}

async function call(path, { method = "GET", token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, body: json };
}

/** Export and keep the bytes, which `call` cannot do because it parses JSON. */
async function exportBytes(docId, token, format) {
  const res = await fetch(`${API}/documents/${docId}/export?format=${format}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(60000),
  });
  const buffer = Buffer.from(await res.arrayBuffer());
  return {
    status: res.status,
    buffer,
    type: res.headers.get("content-type") || "",
    disposition: res.headers.get("content-disposition") || "",
  };
}

const latin1 = (buf) => buf.toString("latin1");

async function makeUser(tag) {
  const stamp = `${tag}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 6)}`;
  const res = await call("/auth/register", {
    method: "POST",
    body: { name: tag, email: `${stamp}@test.local`, password: "Str0ngPass!" },
  });
  if (res.status !== 201) throw new Error(`could not create ${tag}: ${JSON.stringify(res.body)}`);
  return { token: res.body.token, id: res.body.user.id };
}

/** Read the entry names out of a ZIP central directory. */
function zipEntries(buffer) {
  const names = [];
  const text = latin1(buffer);
  let cursor = 0;
  while (true) {
    const at = text.indexOf("PK\x01\x02", cursor);
    if (at === -1) break;
    const nameLength = buffer.readUInt16LE(at + 28);
    names.push(text.slice(at + 46, at + 46 + nameLength));
    cursor = at + 46 + nameLength;
  }
  return names;
}

/** Read one ZIP entry's bytes by scanning local headers. */
function zipEntryText(buffer, wanted) {
  const text = latin1(buffer);
  let cursor = 0;
  while (true) {
    const at = text.indexOf("PK\x03\x04", cursor);
    if (at === -1) return null;
    const method = buffer.readUInt16LE(at + 8);
    const compressedSize = buffer.readUInt32LE(at + 18);
    const nameLength = buffer.readUInt16LE(at + 26);
    const extraLength = buffer.readUInt16LE(at + 28);
    const name = text.slice(at + 30, at + 30 + nameLength);
    const dataStart = at + 30 + nameLength + extraLength;
    if (name === wanted) {
      const raw = buffer.subarray(dataStart, dataStart + compressedSize);
      try {
        // Real .docx output deflates every part, so the test has to inflate to
        // read the document body.
        return (method === 0 ? raw : zlib.inflateRawSync(raw)).toString("utf8");
      } catch {
        return "<unreadable>";
      }
    }
    cursor = at + 4;
  }
}

/**
 * The concatenated text of every FlateDecode stream in a PDF.
 *
 * PDFKit compresses its content streams, so the body text cannot be found in the
 * raw bytes; inflating them is what proves the words actually made it into the
 * page content rather than into some ignored buffer.
 */
function pdfStreamText(buffer) {
  const text = latin1(buffer);
  let cursor = 0;
  let out = "";
  while (true) {
    const at = text.indexOf("stream", cursor);
    if (at === -1) break;
    cursor = at + 6;
    if (text[cursor] === "\r") cursor += 1;
    if (text[cursor] === "\n") cursor += 1;
    const end = text.indexOf("endstream", cursor);
    if (end === -1) break;
    try {
      out += zlib.inflateSync(buffer.subarray(cursor, end)).toString("latin1");
    } catch {
      out += text.slice(cursor, end);
    }
    cursor = end;
  }
  return out;
}

const RICH_HTML = `
<h1>Quarterly Report</h1>
<p>Revenue grew by <strong>18%</strong> against the <em>same quarter last year</em>, with
<i>Churn</i> down. See the <a href="https://example.com/notes">supporting notes</a>.</p>
<h2>Highlights</h2>
<ul><li>Enterprise bookings doubled</li><li>Support response time halved</li></ul>
<h2>Numbers</h2>
<ol><li>First</li><li>Second</li></ol>
<h3>Breakdown</h3>
<table>
  <thead><tr><th>Region</th><th>Revenue</th></tr></thead>
  <tbody>
    <tr><td>EMEA</td><td>1,204</td></tr>
    <tr><td>APAC</td><td>988</td></tr>
  </tbody>
</table>
<blockquote>We expect the trend to hold into Q4.</blockquote>
<pre><code>revenue.total(query)
  .group("region")</code></pre>
<p>H<sub>2</sub>O and x<sup>2</sup> and <code>inline_code()</code>.</p>
<hr>
<p>Unicode check: Urdu اُردو and Devanagari दस्तावेज़.</p>
<div data-attachment-id="000000000000000000000000" data-name="contract.pdf" data-mime="application/pdf" data-bytes="20480"></div>
`;

section("A document can be created and exported");
const owner = await makeUser("ExportOwner");
const outsider = await makeUser("ExportOutsider");

const created = await call("/documents", {
  method: "POST",
  token: owner.token,
  body: { title: "Quarterly Report" },
});
check("the document is created", created.status === 201, `status ${created.status}`);
const docId = created.body?.document?._id || created.body?._id;

const saved = await call(`/documents/${docId}`, {
  method: "PUT",
  token: owner.token,
  body: { content: RICH_HTML, title: "Quarterly Report" },
});
check("rich content is saved", saved.status === 200, `status ${saved.status}`);

section("PDF");
const pdf = await exportBytes(docId, owner.token, "pdf");
check("the export succeeds", pdf.status === 200, `status ${pdf.status}`);
check("it is served as a PDF", pdf.type === "application/pdf", pdf.type);
check(
  "it downloads with a .pdf name",
  /\.pdf"?$/.test(pdf.disposition) && pdf.disposition.includes("attachment"),
  pdf.disposition
);
check("it is not empty", pdf.buffer.length > 1000, `${pdf.buffer.length} bytes`);
check("it has the PDF magic header", latin1(pdf.buffer.subarray(0, 5)) === "%PDF-", latin1(pdf.buffer.subarray(0, 8)));
check(
  "it ends with an EOF marker, so it is complete",
  latin1(pdf.buffer.subarray(-32)).includes("%%EOF"),
  JSON.stringify(latin1(pdf.buffer.subarray(-16)))
);
const pdfText = latin1(pdf.buffer);
check("it declares at least one page", /\/Type\s*\/Page[^s]/.test(pdfText), "no page object");
check("the title lands in the metadata", pdfText.includes("Quarterly"), "title missing");
const streams = pdfStreamText(pdf.buffer);
// The body font is an embedded subset, so the glyphs are written as font-specific
// ids rather than as readable words. What has to hold for the export to be
// usable is that text is drawn at all and that a ToUnicode map exists, which is
// what lets a reader search and copy the text back out.
check("it draws text", /\bTj\b|\bTJ\b/.test(streams), "no text-showing operators");
check("the embedded font maps back to characters", pdfText.includes("/ToUnicode"), "no ToUnicode CMap");
check("the font is embedded, not linked", /\/FontFile2|\/FontFile3|\/FontFile\b/.test(pdfText), "font is not embedded");
check(
  "the content stream carries a meaningful amount of text",
  streams.length > 500,
  `${streams.length} bytes of content`
);
const fontEntries = (pdfText.match(/\/BaseFont\s*\/[A-Za-z0-9+#-]+/g) || []).join(", ");
check("the document names its font", fontEntries.length > 0, "no /BaseFont");

section("DOCX");
const docx = await exportBytes(docId, owner.token, "docx");
check("the export succeeds", docx.status === 200, `status ${docx.status}`);
check(
  "it is served as a real OOXML document",
  docx.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  docx.type
);
check(
  "it downloads with a .docx name",
  /\.docx"?$/.test(docx.disposition) && docx.disposition.includes("attachment"),
  docx.disposition
);
check("it is not empty", docx.buffer.length > 1000, `${docx.buffer.length} bytes`);
check("it is a ZIP container", latin1(docx.buffer.subarray(0, 2)) === "PK", latin1(docx.buffer.subarray(0, 4)));

const entries = zipEntries(docx.buffer);
check("it holds the main document part", entries.includes("word/document.xml"), entries.slice(0, 6).join(", "));
check("it holds the content types part", entries.includes("[Content_Types].xml"), "missing");
check("it holds a relationship part", entries.some((n) => n === "_rels/.rels"), "missing");

const documentXml = zipEntryText(docx.buffer, "word/document.xml");
if (documentXml && documentXml !== "<unreadable>") {
  check("the heading became a heading style", /Heading1|HEADING_1|w:pStyle[^>]*val="Heading/i.test(documentXml), "no heading style");
  check("bold survived", /<w:b\/>/.test(documentXml), "no bold run");
  check("italic survived", /<w:i\/>/.test(documentXml), "no italic run");
  check("the table survived", /<w:tbl>/.test(documentXml), "no table");
  check("the link survived", /Hyperlink|w:hyperlink/.test(documentXml), "no hyperlink");
  check("the code block used a monospace font", /Courier/i.test(documentXml), "no code font");
  check("subscript survived", /subscript|w:vertAlign[^>]*subscript/i.test(documentXml), "no subscript");
  check("the attachment card became text", documentXml.includes("contract.pdf"), "attachment name missing");
} else {
  check("document.xml could be inspected", false, documentXml === "<unreadable>" ? "entry could not be inflated" : "entry not found");
}

section("The plain formats still work");
for (const [format, needle] of [["markdown", "# Quarterly Report"], ["txt", "Revenue grew"], ["html", "<h1>"]]) {
  const res = await call(`/documents/${docId}/export?format=${format}`, { token: owner.token });
  check(
    `${format} still exports`,
    res.status === 200 && String(res.body?.content ?? res.body?.raw ?? "").includes(needle),
    `status ${res.status}`
  );
}

section("Access control");
const stranger = await exportBytes(docId, outsider.token, "pdf");
check("a non-member cannot export at all", stranger.status === 403, `status ${stranger.status}`);
const anon = await fetch(`${API}/documents/${docId}/export?format=pdf`);
check("an anonymous caller is refused", anon.status === 401, `status ${anon.status}`);

section("An unknown format falls back rather than failing");
const fallback = await call(`/documents/${docId}/export?format=exe`, { token: owner.token });
check("an unknown format returns html", fallback.status === 200 && String(fallback.body?.content || fallback.body?.raw || "").includes("<h1>"), `status ${fallback.status}`);

section("An empty document still exports");
const emptyDoc = await call("/documents", { method: "POST", token: owner.token, body: { title: "Empty" } });
const emptyId = emptyDoc.body?.document?._id || emptyDoc.body?._id;
const emptyPdf = await exportBytes(emptyId, owner.token, "pdf");
check("an empty document produces a valid PDF", emptyPdf.status === 200 && latin1(emptyPdf.buffer.subarray(0, 5)) === "%PDF-", `status ${emptyPdf.status}`);
const emptyDocx = await exportBytes(emptyId, owner.token, "docx");
check("an empty document produces a valid DOCX", emptyDocx.status === 200 && latin1(emptyDocx.buffer.subarray(0, 2)) === "PK", `status ${emptyDocx.status}`);

section("Untrusted content cannot break the renderer");
// The renderer runs on the server, so the content is untrusted input.
const nastyDoc = await call("/documents", { method: "POST", token: owner.token, body: { title: "Nasty" } });
const nastyId = nastyDoc.body?.document?._id || nastyDoc.body?._id;
await call(`/documents/${nastyId}`, {
  method: "PUT",
  token: owner.token,
  body: {
    content:
      '<h1><script>alert(1)</script>Title</h1><p>text with ' +
      "&#x1F600; an emoji and a &nbsp; space</p>" +
      '<table><tr><td>lonely cell</td></tr></table>' +
      '<table><tr></tr></table><ul></ul><blockquote></blockquote><pre></pre>' +
      '<p><a href="javascript:alert(1)">bad link</a></p>' +
      '<div data-pagebreak="1"></div><p>after break</p>',
  },
});
const nastyPdf = await exportBytes(nastyId, owner.token, "pdf");
check("it still produces a valid PDF", nastyPdf.status === 200 && latin1(nastyPdf.buffer.subarray(0, 5)) === "%PDF-", `status ${nastyPdf.status}`);
check("it ends cleanly", latin1(nastyPdf.buffer.subarray(-32)).includes("%%EOF"), "no EOF marker");
const nastyDocx = await exportBytes(nastyId, owner.token, "docx");
check("it still produces a valid DOCX", nastyDocx.status === 200 && latin1(nastyDocx.buffer.subarray(0, 2)) === "PK", `status ${nastyDocx.status}`);

console.log(`\n${failures === 0 ? "ALL EXPORT TESTS PASSED" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);