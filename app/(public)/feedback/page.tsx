"use client";

import { useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { upload } from "@vercel/blob/client";
import { ATTACHMENT_LIMITS } from "@/lib/feedback/attachments";
import { AuthPageFrame } from "@/components/layout/AuthPageFrame";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

const FIELD_CLASS =
  "w-full rounded-lg border border-navy/20 bg-white px-3 py-2 text-sm text-ink placeholder:text-muted focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:placeholder:text-slate-500";

const MAX_MB = ATTACHMENT_LIMITS.maxBytes / (1024 * 1024);

/** Client-side pre-check; the upload route enforces the same limits. */
function checkFiles(files: File[]): string | null {
  if (files.length > ATTACHMENT_LIMITS.maxFiles) {
    return `You can attach up to ${ATTACHMENT_LIMITS.maxFiles} screenshots.`;
  }
  for (const f of files) {
    if (!(ATTACHMENT_LIMITS.contentTypes as readonly string[]).includes(f.type)) {
      return `${f.name} is not a PNG or JPEG image.`;
    }
    if (f.size > ATTACHMENT_LIMITS.maxBytes) {
      return `${f.name} is larger than ${MAX_MB} MB.`;
    }
  }
  return null;
}

function uploadName(f: File, i: number): string {
  const ext = f.type === "image/png" ? "png" : "jpg";
  return `${ATTACHMENT_LIMITS.pathPrefix}screenshot-${i + 1}.${ext}`;
}

export default function FeedbackPage() {
  const { status } = useSession();
  const signedIn = status === "authenticated";
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [kind, setKind] = useState<"bug" | "feature" | "question" | "other">(
    "other"
  );
  const [steps, setSteps] = useState("");
  const [website, setWebsite] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [errorHint, setErrorHint] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setErrorHint(null);
    const fileError = signedIn ? checkFiles(files) : null;
    if (fileError) {
      setError(fileError);
      return;
    }
    setPending(true);
    let attachments: string[] = [];
    if (signedIn && files.length > 0) {
      try {
        const blobs = await Promise.all(
          files.map((f, i) =>
            upload(uploadName(f, i), f, {
              access: "public",
              handleUploadUrl: "/api/feedback/upload/",
              contentType: f.type,
            })
          )
        );
        attachments = blobs.map((b) => b.url);
      } catch {
        setError(
          "Could not upload your screenshots. Try again, or remove them and send the message without them."
        );
        setPending(false);
        return;
      }
    }
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          message: message.trim(),
          kind,
          steps: kind === "bug" ? steps.trim() : "",
          website,
          attachments,
          context: {
            pagePath: window.location.pathname,
            online: navigator.onLine,
          },
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        hint?: string;
      };
      if (!res.ok) {
        setError(data.error ?? "Could not send feedback.");
        setErrorHint(data.hint ?? null);
        setPending(false);
        return;
      }
      setDone(true);
      setPending(false);
    } catch {
      setError("Something went wrong.");
      setPending(false);
    }
  }

  return (
    <AuthPageFrame>
      <Card className="w-full max-w-lg">
        <h1 className="text-xl font-bold text-navy">
          Feedback &amp; change requests
        </h1>
        <p className="mt-1 text-sm text-muted">
          Ask questions, report problems, or describe features and workflow
          changes you&apos;d like. Messages go to{" "}
          <a
            href="mailto:info@auctionmethod.com"
            className="font-medium text-navy underline dark:text-slate-200"
          >
            info@auctionmethod.com
          </a>{" "}
          and we read every one to plan improvements.
        </p>

        {done ? (
          <p className="mt-6 text-sm text-ink" role="status">
            Thanks—your message was sent. We&apos;ll get back to you if a reply
            is needed.
          </p>
        ) : (
          <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
            {error ? (
              <div role="alert">
                <p className="text-sm text-danger">{error}</p>
                {errorHint ? (
                  <p className="mt-2 text-xs leading-relaxed text-muted">
                    {errorHint}
                  </p>
                ) : null}
              </div>
            ) : null}
            <Input
              id="feedback-name"
              label="Name (optional)"
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
            />
            <Input
              id="feedback-email"
              label="Your email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <div className="w-full">
              <label
                htmlFor="feedback-kind"
                className="mb-1 block text-sm font-medium text-ink"
              >
                What is this about?
              </label>
              <select
                id="feedback-kind"
                className={FIELD_CLASS}
                value={kind}
                onChange={(e) =>
                  setKind(e.target.value as typeof kind)
                }
              >
                <option value="bug">Something is broken</option>
                <option value="feature">A feature or workflow change</option>
                <option value="question">A question</option>
                <option value="other">Something else</option>
              </select>
            </div>
            <div className="w-full">
              <label
                htmlFor="feedback-message"
                className="mb-1 block text-sm font-medium text-ink"
              >
                Message
              </label>
              <textarea
                id="feedback-message"
                className={`${FIELD_CLASS} min-h-[140px]`}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                required
                minLength={10}
                maxLength={8000}
                placeholder="What would you like changed or added? What went wrong? Be as specific as you can…"
              />
              <p className="mt-1 text-xs text-muted">
                {message.length.toLocaleString()} / 8,000 characters
              </p>
            </div>
            {kind === "bug" ? (
              <div className="w-full">
                <label
                  htmlFor="feedback-steps"
                  className="mb-1 block text-sm font-medium text-ink"
                >
                  What were you doing when it happened? (optional)
                </label>
                <textarea
                  id="feedback-steps"
                  className={`${FIELD_CLASS} min-h-[90px]`}
                  value={steps}
                  onChange={(e) => setSteps(e.target.value)}
                  maxLength={4000}
                  placeholder="Which page, which event or lot, what you clicked, what you expected…"
                />
              </div>
            ) : null}
            {signedIn ? (
              <div className="w-full">
                <label
                  htmlFor="feedback-screenshots"
                  className="mb-1 block text-sm font-medium text-ink"
                >
                  Screenshots (optional)
                </label>
                <input
                  id="feedback-screenshots"
                  type="file"
                  accept={ATTACHMENT_LIMITS.contentTypes.join(",")}
                  multiple
                  className="block w-full text-sm text-ink file:mr-3 file:rounded-lg file:border-0 file:bg-navy/10 file:px-3 file:py-2 file:text-sm file:font-medium file:text-navy dark:text-slate-100 dark:file:bg-slate-700 dark:file:text-slate-100"
                  onChange={(e) => {
                    const picked = Array.from(e.target.files ?? []);
                    setFiles(picked);
                    setError(checkFiles(picked));
                  }}
                />
                <p className="mt-1 text-xs text-muted">
                  Up to {ATTACHMENT_LIMITS.maxFiles} PNG or JPEG images,{" "}
                  {MAX_MB} MB each. Anyone with the link can view an attached
                  image, so leave out anything private.
                </p>
              </div>
            ) : null}
            <div className="hidden" aria-hidden>
              <label htmlFor="feedback-website">Website</label>
              <input
                id="feedback-website"
                name="website"
                type="text"
                tabIndex={-1}
                autoComplete="off"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
              />
            </div>
            <Button type="submit" className="w-full" disabled={pending}>
              {pending ? "Sending…" : "Send message"}
            </Button>
          </form>
        )}

        <p className="mt-6 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-center text-sm text-muted">
          <Link
            href="/dashboard/"
            className="font-medium text-navy underline dark:text-slate-200"
          >
            Back to ClerkBid
          </Link>
          <span className="text-navy/25 dark:text-slate-600" aria-hidden>
            ·
          </span>
          <Link
            href="/"
            className="font-medium text-navy underline dark:text-slate-200"
          >
            Home
          </Link>
        </p>
      </Card>
    </AuthPageFrame>
  );
}
