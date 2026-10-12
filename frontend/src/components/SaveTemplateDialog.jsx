"use client";

import { useState } from "react";
import { LayoutTemplate, Loader2 } from "lucide-react";
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
import { saveTemplateFromDocument } from "@/lib/api";

/**
 * "Save as template" (master plan section 32).
 *
 * Freezes the current body into the workspace's template library. The server copies
 * the content, so later edits to this document deliberately do not follow -- which is
 * the whole point of saving a template.
 */

const CATEGORIES = ["Custom", "Business", "Education", "Personal"];

export default function SaveTemplateDialog({ open, onOpenChange, docId, docTitle, workspaceId }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("Custom");
  const [tags, setTags] = useState("");
  const [saving, setSaving] = useState(false);

  // Default the name to the document's own title only while the field is untouched,
  // so a user who typed something does not have their choice overwritten.
  const effectiveTitle = title.trim() || docTitle;

  function reset() {
    setTitle("");
    setDescription("");
    setCategory("Custom");
    setTags("");
  }

  async function save() {
    setSaving(true);
    try {
      await saveTemplateFromDocument({
        documentId: docId,
        title: effectiveTitle,
        description: description.trim() || undefined,
        category,
        tags: tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
          .slice(0, 8),
        workspaceId: workspaceId || undefined,
      });
      toast.success(`Saved "${effectiveTitle}" as a template`);
      reset();
      onOpenChange(false);
    } catch (err) {
      console.error(err);
      toast.error(err.message || "Could not save the template");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LayoutTemplate className="size-4 text-zinc-500" />
            Save as template
          </DialogTitle>
          <DialogDescription>
            Anyone in this workspace can start a new document from it.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="tpl-name" className="text-sm font-medium text-zinc-700">
              Template name
            </label>
            <Input
              id="tpl-name"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={docTitle}
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="tpl-desc" className="text-sm font-medium text-zinc-700">
              Description
            </label>
            <Textarea
              id="tpl-desc"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this template is for"
            />
          </div>

          <div className="flex gap-2">
            <div className="flex flex-1 flex-col gap-1">
              <label htmlFor="tpl-cat" className="text-sm font-medium text-zinc-700">
                Category
              </label>
              <select
                id="tpl-cat"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="h-9 rounded-md border border-zinc-200 bg-white px-3 text-sm outline-none focus:border-blue-400"
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-1 flex-col gap-1">
              <label htmlFor="tpl-tags" className="text-sm font-medium text-zinc-700">
                Tags
              </label>
              <Input
                id="tpl-tags"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="brand, legal"
              />
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? <Loader2 className="animate-spin" /> : null}
            Save template
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
