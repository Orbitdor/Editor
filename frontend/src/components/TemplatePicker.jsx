"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  FileText,
  Loader2,
  Search,
  Sparkles,
  Trash2,
  Wand2,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  getTemplates,
  getTemplate,
  getSmartPrompts,
  generateTemplate,
  createDocFromTemplate,
  deleteTemplate,
} from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * The template picker (master plan sections 32 and 33).
 *
 * Three things live in one dialog because they are three ways of answering "what
 * should this document be?": a built-in card, a team's saved template, or an AI
 * draft. Picking any of them ends the same way -- a new document in the workspace
 * currently in view -- so the caller only has to route on the result.
 *
 * `values` is merged server-side into `{{placeholders}}`, so this component never
 * touches the template HTML itself.
 */

/** Field types the built-in templates declare, mapped to a control. */
function FieldInput({ field, value, onChange }) {
  const id = `tpl-field-${field.name}`;
  const common = {
    id,
    value: value ?? "",
    onChange: (e) => onChange(e.target.value),
    placeholder: field.hint || field.label,
  };

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-zinc-700">
        {field.label}
        {field.required ? <span className="text-red-500"> *</span> : null}
      </label>
      {field.type === "textarea" ? (
        <Textarea {...common} rows={3} />
      ) : field.type === "select" ? (
        <select
          {...common}
          className="h-9 rounded-md border border-zinc-200 bg-white px-3 text-sm outline-none focus:border-blue-400"
        >
          <option value="">Choose...</option>
          {field.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : (
        // `date` and `number` still go through a text input: the value is sent as a
        // string anyway, and a native date picker reformats it on the way out.
        <Input {...common} />
      )}
      {field.hint ? <p className="text-xs text-zinc-500">{field.hint}</p> : null}
    </div>
  );
}

/** One template card in the grid. */
function TemplateCard({ template, active, canDelete, onPick, onDelete }) {
  return (
    <div
      className={cn(
        "group relative flex flex-col gap-1 rounded-lg border p-3 text-left transition",
        active
          ? "border-blue-500 bg-blue-50 ring-1 ring-blue-500"
          : "border-zinc-200 bg-white hover:border-blue-300 hover:bg-blue-50/40"
      )}
    >
      <button type="button" onClick={() => onPick(template)} className="flex flex-col gap-1 text-left">
        <span className="text-lg leading-none" aria-hidden="true">
          {template.icon || "📄"}
        </span>
        <span className="text-sm font-medium text-zinc-900">{template.title}</span>
        {template.description ? (
          <span className="line-clamp-2 text-xs text-zinc-500">{template.description}</span>
        ) : null}
        {template.builtIn ? null : (
          <span className="mt-1 text-[10px] uppercase tracking-wide text-zinc-400">
            Team template
          </span>
        )}
      </button>
      {canDelete ? (
        <button
          type="button"
          aria-label={`Delete ${template.title}`}
          onClick={() => onDelete(template)}
          className="absolute right-2 top-2 rounded p-1 text-zinc-400 opacity-0 transition hover:bg-red-50 hover:text-red-600 focus:opacity-100 group-hover:opacity-100"
        >
          <Trash2 className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

export default function TemplatePicker({
  open,
  onOpenChange,
  workspaceId,
  folderId,
  canCreate,
  activeRole,
}) {
  const router = useRouter();
  const [templates, setTemplates] = useState([]);
  const [category, setCategory] = useState("");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);

  // Loading is derived rather than set from inside an effect: a grid is stale until
  // the key it was fetched with changes. `reloadToken` is bumped by the handlers
  // below (delete, generate) so a refetch can be requested from an event handler
  // instead of from inside a callback.
  const queryKey = `${workspaceId ?? ""}|${category}`;
  const [loadedKey, setLoadedKey] = useState(null);
  const [reloadToken, setReloadToken] = useState(0);
  const loading = open && loadedKey !== queryKey;

  const [active, setActive] = useState(null);
  const [title, setTitle] = useState("");
  const [values, setValues] = useState({});
  const [step, setStep] = useState("browse");

  // Smart templates (section 33)
  const [prompts, setPrompts] = useState([]);
  const [kinds, setKinds] = useState([]);
  const [kind, setKind] = useState("");
  const [aiPrompt, setAiPrompt] = useState("");
  const [generating, setGenerating] = useState(false);
  const [draft, setDraft] = useState(null);

  useEffect(() => {
    if (!open) return undefined;
    let live = true;
    const key = `${workspaceId ?? ""}|${category}`;

    getTemplates({ workspaceId, category: category || undefined })
      .then((data) => {
        if (!live) return;
        setTemplates(data.templates || []);
        setLoadedKey(key);
      })
      .catch((err) => {
        if (!live) return;
        console.error(err);
        toast.error(err.message || "Could not load templates");
        // Mark the key as loaded so the grid does not spin forever on failure; the
        // toast is the signal, and a category toggle retries.
        setLoadedKey(key);
      });

    return () => {
      live = false;
    };
  }, [open, workspaceId, category, reloadToken]);

  useEffect(() => {
    if (!open) return;
    getSmartPrompts()
      .then((data) => {
        setPrompts(data.prompts || []);
        setKinds(data.kinds || []);
      })
      // The suggestions are a convenience: the dialog still works without them.
      .catch(() => {});
  }, [open]);

  // Client-side search, so typing does not fire a request per keystroke.
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return templates;
    return templates.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        (t.description || "").toLowerCase().includes(q) ||
        (t.tags || []).some((tag) => tag.toLowerCase().includes(q))
    );
  }, [templates, search]);

  function reset() {
    setActive(null);
    setDraft(null);
    setValues({});
    setTitle("");
    setStep("browse");
    setAiPrompt("");
  }

  function close() {
    reset();
    onOpenChange(false);
  }

  /** Open a template: fetch its body, then show the field form. */
  async function pick(template) {
    setBusy(true);
    try {
      const data = await getTemplate(template._id, { workspaceId });
      setActive(data.template);
      setValues({});
      setTitle(data.template.title);
      setStep(data.template.fields?.length ? "fill" : "ready");
    } catch (err) {
      console.error(err);
      toast.error(err.message || "Could not open that template");
    } finally {
      setBusy(false);
    }
  }

  /** Create the document from the chosen template. */
  async function createFromTemplate() {
    if (!active) return;
    setBusy(true);
    try {
      const result = await createDocFromTemplate(active._id, {
        title: title.trim() || undefined,
        values,
        workspaceId: workspaceId || undefined,
        folderId: folderId || undefined,
      });
      close();
      router.push(`/editor/${result.document._id}`);
    } catch (err) {
      console.error(err);
      toast.error(err.message || "Could not create the document");
    } finally {
      setBusy(false);
    }
  }

  /** Use the generated draft: it is saved, so it goes straight into the library. */
  async function useDraft() {
    if (!draft?._id) return;
    setActive({ ...draft, fields: draft.fields || [] });
    setValues({});
    setTitle(draft.title);
    setStep(draft.fields?.length ? "fill" : "ready");
  }

  /** Ask the AI for a structure and save it, then let the user fill it in. */
  async function runGenerate() {
    setGenerating(true);
    try {
      const result = await generateTemplate({
        prompt: aiPrompt.trim() || undefined,
        category: kind || undefined,
        save: true,
        workspaceId: workspaceId || undefined,
      });
      setDraft(result);
      setActive({ ...result, fields: result.fields || [] });
      setValues({});
      setTitle(result.title);
      setStep(result.fields?.length ? "fill" : "ready");
      if (result.mock) {
        toast("Generated with the offline mock provider. Set OPENAI_API_KEY for real output.");
      } else {
        toast.success("Template generated");
      }
      setReloadToken((n) => n + 1);
    } catch (err) {
      console.error(err);
      toast.error(err.message || "Could not generate a template");
    } finally {
      setGenerating(false);
    }
  }

  async function removeTemplate(template) {
    if (!window.confirm(`Delete the template "${template.title}"?`)) return;
    try {
      await deleteTemplate(template._id, { workspaceId });
      toast.success("Template deleted");
      if (active?._id === template._id) reset();
      setReloadToken((n) => n + 1);
    } catch (err) {
      console.error(err);
      toast.error(err.message || "Could not delete the template");
    }
  }

  const canDelete = canCreate;

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="size-4 text-zinc-500" />
            New from a template
          </DialogTitle>
          <DialogDescription>
            Start from a built-in template, one your team has saved, or an AI-generated
            structure.
          </DialogDescription>
        </DialogHeader>

        {!canCreate ? (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Your {activeRole} role cannot add documents.
          </p>
        ) : null}

        {/* ---------------------------------------------------- browse */}
        {step === "browse" ? (
          <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto">
            <div className="flex flex-wrap items-center gap-2">
              <label className="relative flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-zinc-400" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search templates"
                  className="pl-8"
                />
              </label>
              <select
                aria-label="Category"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="h-9 rounded-md border border-zinc-200 bg-white px-3 text-sm outline-none focus:border-blue-400"
              >
                <option value="">All categories</option>
                {["Blank", "Business", "Education", "Personal", "Custom"].map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>

            {loading ? (
              <p className="flex items-center gap-2 py-6 text-sm text-zinc-500">
                <Loader2 className="size-4 animate-spin" /> Loading templates...
              </p>
            ) : visible.length === 0 ? (
              <p className="py-6 text-center text-sm text-zinc-500">No templates found.</p>
            ) : (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {visible.map((t) => (
                  <TemplateCard
                    key={t._id}
                    template={t}
                    active={active?._id === t._id}
                    canDelete={canDelete && !t.builtIn}
                    onPick={pick}
                    onDelete={removeTemplate}
                  />
                ))}
              </div>
            )}

            {/* Smart templates, section 33 */}
            <div className="rounded-lg border border-dashed border-zinc-300 p-3">
              <p className="flex items-center gap-2 text-sm font-medium text-zinc-800">
                <Wand2 className="size-4 text-zinc-500" />
                Smart template
              </p>
              <p className="mt-1 text-xs text-zinc-500">
                Describe the document you want and the AI builds the structure, with
                placeholders for the details only you know.
              </p>

              <div className="mt-3 flex flex-col gap-2">
                {prompts.length ? (
                  <div className="flex flex-wrap gap-1.5">
                    {prompts.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => setAiPrompt(p.prompt)}
                        className="rounded-full border border-zinc-200 px-2.5 py-1 text-xs text-zinc-700 transition hover:border-blue-300 hover:bg-blue-50"
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                ) : null}

                <div className="flex gap-2">
                  <select
                    aria-label="Kind"
                    value={kind}
                    onChange={(e) => setKind(e.target.value)}
                    className="h-9 rounded-md border border-zinc-200 bg-white px-3 text-sm outline-none focus:border-blue-400"
                  >
                    <option value="">Let the AI decide</option>
                    {kinds.map((k) => (
                      <option key={k.id} value={k.id}>
                        {k.label}
                      </option>
                    ))}
                  </select>
                  <Input
                    value={aiPrompt}
                    onChange={(e) => setAiPrompt(e.target.value)}
                    placeholder="Create a software proposal"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !generating) runGenerate();
                    }}
                  />
                  <Button onClick={runGenerate} disabled={generating || !canCreate}>
                    {generating ? <Loader2 className="animate-spin" /> : <Sparkles />}
                    Generate
                  </Button>
                </div>
              </div>

              {draft ? (
                <div className="mt-3 rounded border border-blue-200 bg-blue-50 p-2 text-xs text-blue-900">
                  <p className="font-medium">{draft.title}</p>
                  <p className="mt-0.5 line-clamp-2">
                    {draft.description || "Generated structure ready."}
                  </p>
                  <Button size="sm" variant="outline" className="mt-2" onClick={useDraft}>
                    Use this template
                  </Button>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* ------------------------------------------------------ fill */}
        {step !== "browse" && active ? (
          <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto">
            <div className="flex flex-col gap-1">
              <label htmlFor="tpl-title" className="text-sm font-medium text-zinc-700">
                Document title
              </label>
              <Input
                id="tpl-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={active.title}
              />
            </div>

            {active.fields?.length ? (
              <div className="flex flex-col gap-3">
                {active.fields.map((field) => (
                  <FieldInput
                    key={field.name}
                    field={field}
                    value={values[field.name]}
                    onChange={(v) => setValues((prev) => ({ ...prev, [field.name]: v }))}
                  />
                ))}
              </div>
            ) : (
              <p className="text-sm text-zinc-500">
                This template has no fields, so the document starts with its structure in
                place.
              </p>
            )}

            <div className="flex justify-between gap-2">
              <Button variant="outline" onClick={reset}>
                Back
              </Button>
              <Button onClick={createFromTemplate} disabled={busy || !canCreate}>
                {busy ? <Loader2 className="animate-spin" /> : null}
                Create document
              </Button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
