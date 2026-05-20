# Full Stack Engineer — Technical Assessment

## Overview

Build a small web application that accepts a document upload and extracts three specific regions — **signature**, **letterhead**, and **footer** — returning each as a downloadable PNG or JPEG image.

The goal of this exercise is to see how you approach an open-ended problem end to end: UI, server logic, document processing, and the engineering decisions in between. We are more interested in your reasoning and code quality than in perfect extraction accuracy.

## Objective

A user should be able to:

1. Open the website.
2. Upload a document (PDF at minimum; Word `.docx` is a plus).
3. See a preview of the uploaded document.
4. View the three extracted regions (signature, letterhead, footer) as images.
5. Download each extracted region as PNG or JPEG.

## Technical Requirements

- **Language:** TypeScript on both frontend and backend.
- **Stack:** Your choice of frameworks and tooling for both frontend and backend. Be ready to explain why you picked them.
- **Document processing:** Library and tooling choices are entirely up to you. Using an LLM or hosted vision API is allowed but should not be the only mechanism — we want to see your own logic.
- **Output formats:** Extracted regions must be returned as PNG or JPEG.
- **Error handling:** Gracefully handle unsupported files, corrupt documents, and pages where a region cannot be detected.
- **Repository:** Submit as a public or private GitHub repository with clear commit history.

## Scope Guidance

The extraction does not need to be perfect. Reasonable approaches include:

- **Letterhead:** top region of the first page.
- **Footer:** bottom region of each page (or just the last page).
- **Signature:** more open-ended — heuristics on the bottom portion of the last page, contour/ink detection on a rasterized page, or a simple ML model are all valid.

Document your assumptions in the README. If you decide a region is not present, the UI should communicate that clearly.

## Deliverables

1. A GitHub repository with the full source code.
2. A `README.md` containing:
   - Setup and run instructions (a single command to start, ideally via Docker or `npm run dev`).
   - Your architectural choices and trade-offs.
   - Known limitations and what you would improve given more time.
3. At least one sample document in the repo that demonstrates the app working end to end.

## Evaluation Criteria

We will review your submission on:

- **Code quality:** readability, structure, typing, and separation of concerns.
- **Product thinking:** UX of the upload and result flow, sensible defaults, helpful error messages.
- **Engineering decisions:** library choices, API design, how you handled the ambiguity of "extract a signature."
- **Robustness:** behaviour on edge cases (multi-page docs, scanned PDFs, missing regions).
- **Communication:** clarity of your README and commit messages.

We will **not** penalise you for:

- Imperfect extraction accuracy.
- Skipping features you have called out in the README as deliberate trade-offs.

## Bonus (Optional)

Nice-to-haves if you have time, in no particular order:

- Support for scanned PDFs (OCR fallback).
- Support for `.docx` and image inputs.
- Adjustable crop regions in the UI before download.
- Batch upload and ZIP download of all extracted regions.
- Basic tests (unit or end-to-end).
- Dockerised setup.

## Time Expectation

We suggest spending around **4 to 6 hours** on this. If you would naturally spend more, please cap your time and use the README to describe what you would have done with more runway. Submit within **one week** of receiving this brief.

## Questions

If anything is unclear, reach out at any point — knowing when to ask is part of the role.

Good luck, and have fun with it.
