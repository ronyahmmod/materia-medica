export type PrintDispatchResult = 'printed' | 'iframe-printed' | 'blocked';

function collectHeadStylesHtml(): string {
  const parts: string[] = [];
  const styleNodes = document.querySelectorAll('style, link[rel="stylesheet"]');
  styleNodes.forEach((node) => {
    parts.push(node.outerHTML);
  });
  return parts.join('\n');
}

export function buildStandalonePrintableHtml(
  reportHtml: string,
  title: string
): string {
  const headStyles = collectHeadStylesHtml();
  const safeTitle = title
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return `<!DOCTYPE html>
<html lang="${document.documentElement.lang || 'en'}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${safeTitle}</title>
  ${headStyles}
  <style>
    @page { size: A4 portrait; margin: 12mm 14mm; }
    html, body {
      background: #ffffff !important;
      color: #0f172a !important;
      margin: 0 !important;
      padding: 0 !important;
      height: auto !important;
      overflow: visible !important;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .standalone-print-wrap {
      max-width: 900px;
      margin: 0 auto;
      padding: 16px;
      background: #ffffff;
    }
    .print\\:hidden, button {
      display: none !important;
    }
    @media print {
      .standalone-print-wrap {
        max-width: none !important;
        padding: 0 !important;
      }
      .print-report-sheet {
        border: 0 !important;
        border-radius: 0 !important;
        box-shadow: none !important;
        padding: 0 !important;
      }
    }
  </style>
</head>
<body>
  <div class="standalone-print-wrap">
    ${reportHtml}
  </div>
</body>
</html>`;
}

export function downloadPrintableHtmlReport(
  sheetElement: HTMLElement | null,
  filenameBase: string,
  documentTitle: string
): boolean {
  if (!sheetElement) return false;
  const html = buildStandalonePrintableHtml(sheetElement.outerHTML, documentTitle);
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  const safeName =
    filenameBase
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'patient-case-report';
  anchor.href = objectUrl;
  anchor.download = `${safeName}.html`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
  return true;
}

export function findPrintableReportSheet(): HTMLElement | null {
  const candidates = Array.from(document.querySelectorAll('.print-report-sheet'));
  for (const el of candidates) {
    if (el instanceof HTMLElement) {
      return el;
    }
  }
  return null;
}

export async function triggerReliablePrint(options?: {
  sheetElement?: HTMLElement | null;
  documentTitle?: string;
  skipPrimaryWindowPrint?: boolean;
}): Promise<PrintDispatchResult> {
  if (!options?.skipPrimaryWindowPrint) {
    let nativePrintTriggered = false;
    const onBeforePrint = () => {
      nativePrintTriggered = true;
    };
    window.addEventListener('beforeprint', onBeforePrint);

    try {
      window.focus();
      window.print();
    } catch {
      // Some embedded contexts throw on window.print
    }

    await new Promise((resolve) => window.setTimeout(resolve, 300));
    window.removeEventListener('beforeprint', onBeforePrint);

    if (nativePrintTriggered) {
      return 'printed';
    }
  }

  // Fallback 1: Try document.execCommand('print')
  let execTriggered = false;
  const onExecBeforePrint = () => {
    execTriggered = true;
  };
  window.addEventListener('beforeprint', onExecBeforePrint);
  try {
    const execOk = document.execCommand('print', false);
    if (execOk) {
      execTriggered = true;
    }
  } catch {
    // Ignore unsupported execCommand
  }
  await new Promise((resolve) => window.setTimeout(resolve, 250));
  window.removeEventListener('beforeprint', onExecBeforePrint);

  if (execTriggered) {
    return 'printed';
  }

  // Fallback 2: Hidden same-origin iframe print
  const targetSheet = options?.sheetElement ?? findPrintableReportSheet();
  if (!targetSheet) {
    return 'blocked';
  }

  return await new Promise<PrintDispatchResult>((resolve) => {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.position = 'fixed';
    iframe.style.right = '0';
    iframe.style.bottom = '0';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = '0';
    iframe.style.opacity = '0';
    iframe.style.pointerEvents = 'none';

    const cleanup = () => {
      window.setTimeout(() => {
        if (iframe.parentNode) {
          iframe.parentNode.removeChild(iframe);
        }
      }, 1500);
    };

    const html = buildStandalonePrintableHtml(
      targetSheet.outerHTML,
      options?.documentTitle || document.title || 'Patient Case Report'
    );

    iframe.onload = () => {
      const win = iframe.contentWindow;
      if (!win) {
        cleanup();
        resolve('blocked');
        return;
      }

      let iframePrinted = false;
      const markIframePrinted = () => {
        iframePrinted = true;
      };
      try {
        win.addEventListener('beforeprint', markIframePrinted);
        win.focus();
        win.print();
      } catch {
        // Blocked by parent iframe sandbox / mobile WebView
      }

      window.setTimeout(() => {
        try {
          win.removeEventListener('beforeprint', markIframePrinted);
        } catch {
          // Ignore cross-frame teardown errors
        }
        cleanup();
        resolve(iframePrinted ? 'iframe-printed' : 'blocked');
      }, 350);
    };

    document.body.appendChild(iframe);
    iframe.srcdoc = html;
  });
}
