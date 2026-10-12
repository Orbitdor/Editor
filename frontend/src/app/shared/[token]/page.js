"use client";

import { use, useEffect, useState } from "react";
import { Loader2, ShieldAlert } from "lucide-react";
import { EditorContent, useEditor } from "@tiptap/react";
import { buildExtensions } from "@/lib/tiptap";
import { openSharedLink } from "@/lib/api";
import { Button } from "@/components/ui/button";

/**
 * Read-only view of a document opened through "Anyone with the link"
 * (master plan section 21).
 *
 * A link visitor has no session, so there is nothing to save and nowhere to save
 * it. The editor is therefore created with `editable: false` and no collaboration
 * socket: a document that cannot be written should not look like one that can.
 */
export default function SharedLinkPage({ params }) {
  const { token } = use(params);

  const [state, setState] = useState({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    openSharedLink(token)
      .then((data) => {
        if (!cancelled) setState({ status: "ready", document: data.document, link: data.link });
      })
      .catch((err) => {
        if (!cancelled) setState({ status: "error", message: err.message });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (state.status === "loading") {
    return (
      <Frame>
        <div className="flex items-center justify-center gap-2 py-20 text-sm text-zinc-500">
          <Loader2 className="size-4 animate-spin" />
          Opening the document...
        </div>
      </Frame>
    );
  }

  if (state.status === "error") {
    return (
      <Frame>
        <div className="mx-auto max-w-md space-y-3 py-20 text-center">
          <ShieldAlert className="mx-auto size-6 text-zinc-400" />
          <h1 className="text-base font-medium text-zinc-800">This link does not open</h1>
          <p className="text-sm text-zinc-500">{state.message}</p>
          <p className="text-xs text-zinc-400">
            The owner may have turned the link off, let it expire, or moved the document to the
            trash.
          </p>
          <Button variant="outline" size="sm" asChild>
            <a href="/login">Sign in instead</a>
          </Button>
        </div>
      </Frame>
    );
  }

  const doc = state.document;

  return (
    <Frame>
      <header className="mb-6 border-b border-zinc-200 pb-4">
        <h1 className="text-xl font-semibold text-zinc-900">{doc.title}</h1>
        <p className="mt-1 text-xs text-zinc-500">
          Shared with you by link · {state.link?.role === "commenter" ? "can comment" : "read only"}
          {" · "}
          {new Date(doc.updatedAt).toLocaleString()}
        </p>
      </header>
      <SharedBody html={doc.content} />
    </Frame>
  );
}

/**
 * The document body.
 *
 * Rendered with the same extension set as the editor so a link shows the same
 * headings, lists and tables, but with editing and every input rule disabled --
 * there is no account to attribute an edit to.
 */
function SharedBody({ html }) {
  const editor = useEditor({
    extensions: buildExtensions({}),
    content: html || "",
    editable: false,
    immediatelyRender: false,
  });

  if (!editor) {
    return (
      <div className="flex items-center gap-2 py-10 text-sm text-zinc-500">
        <Loader2 className="size-4 animate-spin" />
        Preparing the document...
      </div>
    );
  }

  return <EditorContent editor={editor} className="prose prose-zinc max-w-none" />;
}

function Frame({ children }) {
  return (
    <main className="min-h-screen bg-white">
      <div className="mx-auto w-full max-w-3xl px-6 py-10">{children}</div>
    </main>
  );
}
