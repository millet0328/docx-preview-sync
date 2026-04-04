/**
 * splitOversizedSections.ts
 *
 * Post-render utility for docx-preview-sync that splits oversized
 * <section class="docx"> elements into multiple page-sized sections.
 *
 * The library's built-in page break detection only handles explicit
 * markers (lastRenderedPageBreak, section breaks). This utility handles
 * "soft" page breaks — content that overflows the page height without
 * an explicit marker.
 *
 * Usage:
 *   import { splitOversizedSections } from './splitOversizedSections';
 *
 *   // After renderSync completes and layout has stabilized:
 *   splitOversizedSections(container);
 *
 * Recommended: wait for stable layout before calling. Use polling:
 *
 *   let lastHeight = -1, stableCount = 0;
 *   const poll = () => {
 *     const h = container.getBoundingClientRect().height;
 *     if (h === lastHeight && h > 0) stableCount++;
 *     else stableCount = 0;
 *     lastHeight = h;
 *     if (stableCount >= 2) splitOversizedSections(container);
 *     else setTimeout(poll, 200);
 *   };
 *   setTimeout(poll, 200);
 *
 * @license Apache-2.0
 */

interface PageBucket {
  elements: HTMLElement[];
  bottomEdge: number;
}

/**
 * Split any `<section class="docx">` whose content exceeds its
 * page height into multiple sections, one per virtual page.
 *
 * Tiny orphan pages (< 20% of page height or fewer than 2 elements)
 * are merged back into the previous page to prevent single-line pages.
 *
 * @param container - The root element that contains the rendered DOCX sections
 * @param tolerance - Pixel tolerance for height comparison (default: 10)
 */
export function splitOversizedSections(
  container: HTMLElement,
  tolerance = 10,
): void {
  const sections = Array.from(
    container.querySelectorAll<HTMLElement>("section.docx"),
  );
  if (sections.length === 0) return;

  // --- Determine the page content-area height from the first section --------
  const firstSection = sections[0];
  const sectionStyle = window.getComputedStyle(firstSection);
  const pageHeight = parseFloat(sectionStyle.minHeight);

  if (!pageHeight || pageHeight <= 0) return;

  const paddingTop = parseFloat(sectionStyle.paddingTop) || 0;
  const paddingBottom = parseFloat(sectionStyle.paddingBottom) || 0;
  const contentHeight = pageHeight - paddingTop - paddingBottom;

  if (contentHeight <= 0) return;

  // Minimum content height for a page to stand on its own (20% of page)
  const MIN_PAGE_HEIGHT = contentHeight * 0.2;

  // --- Process each section --------------------------------------------------
  for (const section of sections) {
    const article = section.querySelector<HTMLElement>("article");
    if (!article) continue;

    const articleRect = article.getBoundingClientRect();

    // Fast-path: fits in a single page (with tolerance for rounding)
    if (articleRect.height <= contentHeight + tolerance) continue;

    const children = Array.from(article.children) as HTMLElement[];
    if (children.length === 0) continue;

    const articleTop = articleRect.top;

    const pages: PageBucket[] = [{ elements: [], bottomEdge: 0 }];
    let pageStartOffset = 0;

    for (const child of children) {
      const childRect = child.getBoundingClientRect();
      const childBottom = childRect.bottom - articleTop;
      const childTop = childRect.top - articleTop;

      const current = pages[pages.length - 1];
      const heightOnThisPage = childBottom - pageStartOffset;
      const overflow = heightOnThisPage - contentHeight;
      const childHeight = childRect.height;

      // Allow ~1.5 lines of overflow before breaking
      const LINE_HEIGHT_ALLOWANCE = 36;
      const shouldBreak =
        overflow > LINE_HEIGHT_ALLOWANCE &&
        childHeight > 0 &&
        overflow > childHeight * 0.5 &&
        current.elements.length > 0;

      if (shouldBreak) {
        // This child would overflow — start a new virtual page
        pageStartOffset = childTop;
        pages.push({ elements: [child], bottomEdge: childBottom });
      } else {
        current.elements.push(child);
        current.bottomEdge = childBottom;
      }
    }

    // --- Merge tiny pages back into their neighbors -------------------------
    // A page that's too small gets merged into the previous page.
    // This prevents orphan pages like a single "Citizenship Canadian" line.
    const mergedPages: PageBucket[] = [];

    for (let i = 0; i < pages.length; i++) {
      const bucket = pages[i];

      // Calculate actual content height of this bucket
      let bucketHeight = 0;
      if (bucket.elements.length > 0) {
        const firstEl = bucket.elements[0].getBoundingClientRect();
        const lastEl =
          bucket.elements[bucket.elements.length - 1].getBoundingClientRect();
        bucketHeight = lastEl.bottom - firstEl.top;
      }

      // Use OR: either too short or too few elements → merge
      const isTiny =
        bucketHeight < MIN_PAGE_HEIGHT || bucket.elements.length < 2;

      if (isTiny && mergedPages.length > 0) {
        // Merge into previous page
        const prev = mergedPages[mergedPages.length - 1];
        for (const el of bucket.elements) {
          prev.elements.push(el);
        }
        prev.bottomEdge = bucket.bottomEdge;
      } else if (isTiny && mergedPages.length === 0) {
        // First page is tiny — keep it, next page will absorb if needed
        mergedPages.push(bucket);
      } else {
        mergedPages.push(bucket);
      }
    }

    // Final check: merge last page if it has fewer than 2 elements
    if (
      mergedPages.length > 1 &&
      mergedPages[mergedPages.length - 1].elements.length < 2
    ) {
      const lastBucket = mergedPages.pop()!;
      const prev = mergedPages[mergedPages.length - 1];
      for (const el of lastBucket.elements) {
        prev.elements.push(el);
      }
      prev.bottomEdge = lastBucket.bottomEdge;
    }

    // Nothing to split
    if (mergedPages.length <= 1) continue;

    // --- Build replacement sections -----------------------------------------
    const sectionClasses = section.className;
    const sectionInlineStyle = section.getAttribute("style") || "";

    const newSections: HTMLElement[] = [];

    for (let i = 0; i < mergedPages.length; i++) {
      let sec: HTMLElement;
      let art: HTMLElement;

      if (i === 0) {
        // Reuse the original section for the first page
        sec = section;
        art = article;
        art.innerHTML = "";
      } else {
        sec = document.createElement("section");
        sec.className = sectionClasses;
        sec.setAttribute("style", sectionInlineStyle);
        art = document.createElement("article");
        sec.appendChild(art);
      }

      for (const el of mergedPages[i].elements) {
        art.appendChild(el);
      }

      newSections.push(sec);
    }

    // Insert the newly-created sections right after the original
    let insertAfter: HTMLElement = section;
    for (let i = 1; i < newSections.length; i++) {
      insertAfter.after(newSections[i]);
      insertAfter = newSections[i];
    }
  }
}
