/**
 * The built-in templates of master plan section 32.
 *
 * They live in code rather than in a seed script so that a fresh install has them
 * immediately and an existing install picks up new ones on upgrade, with no
 * migration to remember. `ensureBuiltIns` writes any that are missing and never
 * touches one a workspace has already customised.
 *
 * Every placeholder is `{{snake_case}}` and has a matching entry in `fields`, so
 * the picker can build the form without parsing the HTML, and the AI generator can
 * be told what a "software proposal" is expected to contain.
 */

/** Shorthand for a field, to keep the definitions readable. */
const field = (name, label, type = "text", extra = {}) => ({
  name,
  label,
  type,
  ...extra,
});

export const BUILT_IN_TEMPLATES = [
  {
    title: "Blank Document",
    category: "Blank",
    icon: "📄",
    description: "An empty document with a title and nothing else.",
    tags: ["blank", "empty", "start"],
    content: "",
    fields: [],
  },

  /* ---------------------------------------------------------------- Business */

  {
    title: "Proposal",
    category: "Business",
    icon: "📊",
    description: "A client proposal with scope, deliverables, timeline and pricing.",
    tags: ["sales", "client", "proposal", "quote"],
    fields: [
      field("client_name", "Client name"),
      field("client_company", "Client company"),
      field("prepared_by", "Prepared by"),
      field("valid_until", "Valid until", "date"),
      field("project_summary", "Project summary", "textarea", {
        hint: "Two or three sentences on the problem and the approach.",
        required: true,
      }),
      field("scope", "Scope of work", "textarea", {
        hint: "One item per line. Each becomes a bullet point.",
      }),
      field("deliverables", "Deliverables", "textarea"),
      field("timeline", "Timeline", "textarea"),
      field("investment", "Investment"),
      field("currency", "Currency", "select", { options: ["USD", "EUR", "GBP", "PKR", "INR", "AED"] }),
      field("terms", "Terms", "textarea"),
    ],
    content: `<h1>{{project_summary}}</h1>
<p>Prepared for <strong>{{client_name}}</strong> at {{client_company}} by {{prepared_by}}.</p>
<h2>Project summary</h2>
<p>{{project_summary}}</p>
<h2>Scope of work</h2>
<p>{{scope}}</p>
<h2>Deliverables</h2>
<p>{{deliverables}}</p>
<h2>Timeline</h2>
<p>{{timeline}}</p>
<h2>Investment</h2>
<p><strong>{{investment}} {{currency}}</strong></p>
<h2>Terms</h2>
<p>{{terms}}</p>
<p><em>This proposal is valid until {{valid_until}}.</em></p>`,
  },

  {
    title: "Invoice",
    category: "Business",
    icon: "🧾",
    description: "A billable invoice with line items, tax and payment terms.",
    tags: ["billing", "invoice", "finance", "sales"],
    fields: [
      field("invoice_number", "Invoice number"),
      field("client_company", "Bill to"),
      field("client_address", "Client address", "textarea"),
      field("issue_date", "Issue date", "date"),
      field("due_date", "Due date", "date"),
      field("line_items", "Line items", "textarea", {
        hint: "One per line as: description | quantity | rate",
        required: true,
      }),
      field("tax_rate", "Tax rate", "number"),
      field("currency", "Currency", "select", { options: ["USD", "EUR", "GBP", "PKR", "INR", "AED"] }),
      field("payment_terms", "Payment terms", "textarea"),
      field("notes", "Notes", "textarea"),
    ],
    content: `<h1>Invoice {{invoice_number}}</h1>
<p>Issued {{issue_date}} · Due {{due_date}}</p>
<h2>Bill to</h2>
<p><strong>{{client_company}}</strong></p>
<p>{{client_address}}</p>
<h2>Items</h2>
<p>{{line_items}}</p>
<h2>Summary</h2>
<p>Subtotal · Tax at {{tax_rate}}% · Total due in {{currency}}</p>
<h2>Payment terms</h2>
<p>{{payment_terms}}</p>
<p>{{notes}}</p>`,
  },

  {
    title: "Report",
    category: "Business",
    icon: "📈",
    description: "A structured report with summary, findings and recommendations.",
    tags: ["report", "analysis", "business"],
    fields: [
      field("report_title", "Report title"),
      field("period", "Reporting period"),
      field("prepared_by", "Prepared by"),
      field("executive_summary", "Executive summary", "textarea", { required: true }),
      field("findings", "Findings", "textarea", { hint: "One finding per line." }),
      field("metrics", "Key metrics", "textarea"),
      field("recommendations", "Recommendations", "textarea"),
      field("conclusion", "Conclusion", "textarea"),
    ],
    content: `<h1>{{report_title}}</h1>
<p>{{period}} · Prepared by {{prepared_by}}</p>
<h2>Executive summary</h2>
<p>{{executive_summary}}</p>
<h2>Key metrics</h2>
<p>{{metrics}}</p>
<h2>Findings</h2>
<p>{{findings}}</p>
<h2>Recommendations</h2>
<p>{{recommendations}}</p>
<h2>Conclusion</h2>
<p>{{conclusion}}</p>`,
  },

  {
    title: "Contract",
    category: "Business",
    icon: "📝",
    description: "A services agreement with parties, scope, payment and termination.",
    tags: ["contract", "agreement", "legal", "business"],
    fields: [
      field("agreement_title", "Agreement title"),
      field("party_a", "First party"),
      field("party_b", "Second party"),
      field("effective_date", "Effective date", "date"),
      field("term", "Term"),
      field("services", "Services", "textarea", { required: true }),
      field("fees", "Fees", "textarea"),
      field("payment_terms", "Payment terms", "textarea"),
      field("confidentiality", "Confidentiality", "textarea"),
      field("termination", "Termination", "textarea"),
      field("governing_law", "Governing law"),
      field("signatory_a", "Signed by (first party)"),
      field("signatory_b", "Signed by (second party)"),
    ],
    content: `<h1>{{agreement_title}}</h1>
<p>This agreement is made on {{effective_date}} between <strong>{{party_a}}</strong> ("Client") and <strong>{{party_b}}</strong> ("Provider").</p>
<h2>1. Services</h2>
<p>{{services}}</p>
<h2>2. Term</h2>
<p>{{term}}</p>
<h2>3. Fees and payment</h2>
<p>{{fees}}</p>
<p>{{payment_terms}}</p>
<h2>4. Confidentiality</h2>
<p>{{confidentiality}}</p>
<h2>5. Termination</h2>
<p>{{termination}}</p>
<h2>6. Governing law</h2>
<p>This agreement is governed by the laws of {{governing_law}}.</p>
<h2>Signatures</h2>
<p>{{signatory_a}}</p>
<p>{{signatory_b}}</p>`,
  },

  {
    title: "Meeting Notes",
    category: "Business",
    icon: "🗒️",
    description: "Agenda, attendees, decisions and actions for a meeting.",
    tags: ["meeting", "minutes", "notes", "business"],
    fields: [
      field("meeting_title", "Meeting title"),
      field("date", "Date", "date"),
      field("time", "Time"),
      field("location", "Location"),
      field("attendees", "Attendees", "textarea"),
      field("agenda", "Agenda", "textarea"),
      field("discussion", "Discussion", "textarea"),
      field("decisions", "Decisions", "textarea"),
      field("actions", "Action items", "textarea", { hint: "One per line as: task | owner | due date" }),
    ],
    content: `<h1>{{meeting_title}}</h1>
<p>{{date}} at {{time}} · {{location}}</p>
<h2>Attendees</h2>
<p>{{attendees}}</p>
<h2>Agenda</h2>
<p>{{agenda}}</p>
<h2>Discussion</h2>
<p>{{discussion}}</p>
<h2>Decisions</h2>
<p>{{decisions}}</p>
<h2>Action items</h2>
<p>{{actions}}</p>`,
  },

  /* --------------------------------------------------------------- Education */

  {
    title: "Assignment",
    category: "Education",
    icon: "📚",
    description: "A coursework assignment with instructions, rubric and submission details.",
    tags: ["assignment", "coursework", "education", "student"],
    fields: [
      field("assignment_title", "Assignment title"),
      field("course", "Course"),
      field("instructor", "Instructor"),
      field("due_date", "Due date", "date"),
      field("overview", "Overview", "textarea", { required: true }),
      field("instructions", "Instructions", "textarea"),
      field("deliverables", "Deliverables", "textarea"),
      field("rubric", "Grading rubric", "textarea"),
      field("resources", "Resources"),
    ],
    content: `<h1>{{assignment_title}}</h1>
<p>{{course}} · {{instructor}} · Due {{due_date}}</p>
<h2>Overview</h2>
<p>{{overview}}</p>
<h2>Instructions</h2>
<p>{{instructions}}</p>
<h2>Deliverables</h2>
<p>{{deliverables}}</p>
<h2>Grading rubric</h2>
<p>{{rubric}}</p>
<h2>Resources</h2>
<p>{{resources}}</p>`,
  },

  {
    title: "Research Paper",
    category: "Education",
    icon: "🔬",
    description: "A research paper outline with abstract, method, results and references.",
    tags: ["research", "paper", "thesis", "education"],
    fields: [
      field("paper_title", "Paper title"),
      field("author", "Author"),
      field("course", "Course or programme"),
      field("abstract", "Abstract", "textarea", { required: true }),
      field("keywords", "Keywords"),
      field("introduction", "Introduction", "textarea"),
      field("literature", "Literature review", "textarea"),
      field("methodology", "Methodology", "textarea"),
      field("results", "Results", "textarea"),
      field("conclusion", "Conclusion", "textarea"),
      field("references", "References", "textarea"),
    ],
    content: `<h1>{{paper_title}}</h1>
<p>{{author}} · {{course}}</p>
<h2>Abstract</h2>
<p>{{abstract}}</p>
<p><strong>Keywords:</strong> {{keywords}}</p>
<h2>1. Introduction</h2>
<p>{{introduction}}</p>
<h2>2. Literature review</h2>
<p>{{literature}}</p>
<h2>3. Methodology</h2>
<p>{{methodology}}</p>
<h2>4. Results</h2>
<p>{{results}}</p>
<h2>5. Conclusion</h2>
<p>{{conclusion}}</p>
<h2>References</h2>
<p>{{references}}</p>`,
  },

  {
    title: "Study Notes",
    category: "Education",
    icon: "🗒️",
    description: "Structured notes with a summary, key points and revision questions.",
    tags: ["notes", "study", "education", "revision"],
    fields: [
      field("topic", "Topic"),
      field("course", "Course"),
      field("date", "Date", "date"),
      field("summary", "Summary", "textarea", { required: true }),
      field("key_points", "Key points", "textarea"),
      field("definitions", "Definitions", "textarea"),
      field("questions", "Revision questions", "textarea"),
    ],
    content: `<h1>{{topic}}</h1>
<p>{{course}} · {{date}}</p>
<h2>Summary</h2>
<p>{{summary}}</p>
<h2>Key points</h2>
<p>{{key_points}}</p>
<h2>Definitions</h2>
<p>{{definitions}}</p>
<h2>Revision questions</h2>
<p>{{questions}}</p>`,
  },

  /* ---------------------------------------------------------------- Personal */

  {
    title: "Resume",
    category: "Personal",
    icon: "📑",
    description: "A CV with contact details, experience, education and skills.",
    tags: ["resume", "cv", "job", "career", "personal"],
    fields: [
      field("full_name", "Full name", "text", { required: true }),
      field("headline", "Headline", "text", { hint: "e.g. Backend engineer" }),
      field("email", "Email", "text"),
      field("phone", "Phone", "text"),
      field("location", "Location", "text"),
      field("links", "Links", "textarea", { hint: "Portfolio, GitHub, LinkedIn" }),
      field("summary", "Professional summary", "textarea"),
      field("experience", "Experience", "textarea", {
        hint: "One role per block, separated by a blank line.",
      }),
      field("education", "Education", "textarea"),
      field("skills", "Skills", "textarea"),
      field("languages", "Languages", "textarea"),
    ],
    content: `<h1>{{full_name}}</h1>
<p><strong>{{headline}}</strong></p>
<p>{{email}} · {{phone}} · {{location}}</p>
<p>{{links}}</p>
<h2>Summary</h2>
<p>{{summary}}</p>
<h2>Experience</h2>
<p>{{experience}}</p>
<h2>Education</h2>
<p>{{education}}</p>
<h2>Skills</h2>
<p>{{skills}}</p>
<h2>Languages</h2>
<p>{{languages}}</p>`,
  },

  {
    title: "Cover Letter",
    category: "Personal",
    icon: "✉️",
    description: "A cover letter addressed to a role, with a close and contact details.",
    tags: ["cover letter", "job", "application", "personal"],
    fields: [
      field("full_name", "Your name", "text", { required: true }),
      field("email", "Email", "text"),
      field("phone", "Phone", "text"),
      field("date", "Date", "date"),
      field("hiring_manager", "Hiring manager", "text"),
      field("company", "Company", "text"),
      field("role", "Role", "text"),
      field("opening", "Opening paragraph", "textarea"),
      field("body", "Why this role", "textarea", { required: true }),
      field("closing", "Closing paragraph", "textarea"),
    ],
    content: `<p>{{full_name}}</p>
<p>{{email}} · {{phone}}</p>
<p>{{date}}</p>
<p>{{hiring_manager}}<br />{{company}}</p>
<p><strong>Re: {{role}}</strong></p>
<p>Dear {{hiring_manager}},</p>
<p>{{opening}}</p>
<p>{{body}}</p>
<p>{{closing}}</p>
<p>Yours sincerely,<br />{{full_name}}</p>`,
  },

  {
    title: "Letter",
    category: "Personal",
    icon: "📄",
    description: "A general letter with a sender, recipient and body.",
    tags: ["letter", "personal", "writing"],
    fields: [
      field("sender_name", "Your name", "text", { required: true }),
      field("sender_address", "Your address", "textarea"),
      field("recipient_name", "Recipient name", "text"),
      field("recipient_address", "Recipient address", "textarea"),
      field("date", "Date", "date"),
      field("subject", "Subject", "text"),
      field("greeting", "Greeting", "text"),
      field("body", "Body", "textarea", { required: true }),
      field("sign_off", "Sign off", "text"),
    ],
    content: `<p>{{sender_name}}<br />{{sender_address}}</p>
<p>{{date}}</p>
<p>{{recipient_name}}<br />{{recipient_address}}</p>
<p><strong>{{subject}}</strong></p>
<p>{{greeting}}</p>
<p>{{body}}</p>
<p>{{sign_off}},<br />{{sender_name}}</p>`,
  },
];

/**
 * The suggestions the AI generator offers, from section 33
 * ("Create a software proposal", "Create a business agreement", ...).
 *
 * These are prompts, not templates: the model invents the structure, and the
 * result is saved as a normal workspace template so it can be reused like any other.
 */
export const SMART_TEMPLATE_PROMPTS = [
  { id: "software-proposal", label: "Software proposal", prompt: "Create a software proposal" },
  { id: "business-agreement", label: "Business agreement", prompt: "Create a business agreement" },
  {
    id: "meeting-minutes",
    label: "Meeting minutes",
    prompt: "Create meeting minutes for a project status review",
  },
];

export const SMART_CATEGORIES = [
  { id: "proposal", label: "Proposal", category: "Business" },
  { id: "agreement", label: "Agreement or contract", category: "Business" },
  { id: "invoice", label: "Invoice", category: "Business" },
  { id: "report", label: "Report", category: "Business" },
  { id: "minutes", label: "Meeting minutes", category: "Business" },
  { id: "policy", label: "Policy or procedure", category: "Business" },
  { id: "assignment", label: "Assignment", category: "Education" },
  { id: "paper", label: "Research paper", category: "Education" },
  { id: "lesson", label: "Lesson plan", category: "Education" },
  { id: "letter", label: "Letter", category: "Personal" },
  { id: "other", label: "Something else", category: "Custom" },
];
