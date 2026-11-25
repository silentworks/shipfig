"use client";

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const COMPONENTS: Components = {
  h1: ({ children }) => <h2 className="mt-5 mb-2 border-b border-zinc-200/80 pb-1.5 text-lg font-semibold text-zinc-900 first:mt-0 dark:border-zinc-800 dark:text-zinc-100">{children}</h2>,
  h2: ({ children }) => <h3 className="mt-5 mb-2 border-b border-zinc-200/80 pb-1 text-base font-semibold text-zinc-900 first:mt-0 dark:border-zinc-800 dark:text-zinc-100">{children}</h3>,
  h3: ({ children }) => <h4 className="mt-4 mb-1.5 text-sm font-semibold text-zinc-900 first:mt-0 dark:text-zinc-100">{children}</h4>,
  h4: ({ children }) => <h5 className="mt-3 mb-1 text-sm font-medium text-zinc-900 first:mt-0 dark:text-zinc-100">{children}</h5>,
  p: ({ children }) => <p className="my-2.5 leading-relaxed text-zinc-800 first:mt-0 last:mb-0 dark:text-zinc-200">{children}</p>,
  ul: ({ children }) => <ul className="my-2.5 list-disc space-y-1 pl-5 text-zinc-800 dark:text-zinc-200">{children}</ul>,
  ol: ({ children }) => <ol className="my-2.5 list-decimal space-y-1 pl-5 text-zinc-800 dark:text-zinc-200">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed [&>input[type=checkbox]]:mr-2 [&>input[type=checkbox]]:align-middle">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-3 border-l-2 border-zinc-300 pl-3.5 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-4 border-zinc-200/80 dark:border-zinc-800" />,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="font-medium text-sky-600 underline decoration-sky-600/30 underline-offset-2 hover:decoration-sky-600 dark:text-sky-400 dark:decoration-sky-400/30 dark:hover:decoration-sky-400"
    >
      {children}
    </a>
  ),
  code: ({ className, children }) => {
    const isBlock = Boolean(className?.includes("language-"));
    if (isBlock) {
      return <code className="font-mono text-xs text-zinc-800 dark:text-zinc-200">{children}</code>;
    }
    return (
      <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[12px] text-zinc-800 dark:bg-zinc-800/90 dark:text-zinc-200">
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="my-3 overflow-x-auto rounded-lg border border-zinc-200/80 bg-zinc-50 p-3.5 font-mono text-xs leading-relaxed text-zinc-800 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200 [&_code]:rounded-none [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-xs">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto rounded-lg border border-zinc-200/80 dark:border-zinc-800">
      <table className="w-full border-collapse text-left text-xs">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-zinc-50 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">{children}</thead>,
  tr: ({ children }) => <tr className="border-t border-zinc-200/80 first:border-t-0 dark:border-zinc-800">{children}</tr>,
  th: ({ children }) => <th className="px-3 py-2 font-semibold">{children}</th>,
  td: ({ children }) => <td className="px-3 py-2 text-zinc-700 dark:text-zinc-300">{children}</td>,
  input: ({ type, checked }) => {
    if (type !== "checkbox") return null;
    return <input type="checkbox" checked={Boolean(checked)} readOnly disabled className="h-3.5 w-3.5 rounded border-zinc-300 accent-sky-600" />;
  },
  img: ({ src, alt }) =>
    typeof src === "string" ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={alt ?? ""}
        loading="lazy"
        referrerPolicy="no-referrer"
        className="my-3 max-h-96 max-w-full rounded-lg border border-zinc-200/80 dark:border-zinc-800"
      />
    ) : null,
};

/**
 * Safe GitHub Flavored Markdown renderer for untrusted issue content.
 * Raw HTML is NOT enabled (no rehype-raw), and URLs are sanitized by react-markdown.
 */
export function Markdown({ content }: { content: string }) {
  return (
    <div className="min-w-0 break-words text-sm">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
