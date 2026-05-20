export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 bg-zinc-50 px-6 py-16 text-center dark:bg-zinc-950">
      <h1 className="text-3xl font-semibold tracking-tight text-zinc-900 sm:text-4xl dark:text-zinc-50">
        Document Extractor
      </h1>
      <p className="max-w-md text-base leading-7 text-balance text-zinc-600 dark:text-zinc-400">
        Upload a PDF, DOCX, or image. We&apos;ll pull out the letterhead, footer, and signature for
        you.
      </p>
      <div className="rounded-md border border-dashed border-zinc-300 px-8 py-12 text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
        Drop zone — coming in task group 9.
      </div>
    </main>
  );
}
