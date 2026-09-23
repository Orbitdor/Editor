"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getDocs, createDoc } from "@/lib/api";

function timeAgo(date) {
  const diff = Date.now() - new Date(date).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function Dashboard() {
  const router = useRouter();
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getDocs()
      .then((data) => {
        if (!cancelled) setDocs(data);
      })
      .catch((err) => {
        console.error(err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleNewDoc() {
    const doc = await createDoc();
    router.push(`/editor/${doc._id}`);
  }

  return (
    <div className="mx-auto w-full max-w-4xl flex-1 px-6 py-10">
      <div className="mb-8 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">My Documents</h1>
        <button
          onClick={handleNewDoc}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700"
        >
          + New document
        </button>
      </div>

      {loading ? (
        <p className="text-zinc-500">Loading...</p>
      ) : docs.length === 0 ? (
        <p className="text-zinc-500">
          No documents yet. Click &quot;+ New document&quot; to create one.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {docs.map((doc) => (
            <Link
              key={doc._id}
              href={`/editor/${doc._id}`}
              className="group rounded-lg border border-zinc-200 bg-white p-5 shadow-sm transition-shadow hover:shadow-md"
            >
              <h2 className="mb-1 truncate font-medium group-hover:text-blue-600">
                {doc.title}
              </h2>
              <p className="line-clamp-3 whitespace-pre-wrap text-sm text-zinc-500">
                {doc.content || "Empty document"}
              </p>
              <p className="mt-3 text-xs text-zinc-400">
                Edited {timeAgo(doc.updatedAt)}
              </p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}