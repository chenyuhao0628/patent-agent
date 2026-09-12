declare module 'mammoth' {
  export function extractRawText(input: { buffer: Buffer }): Promise<{ value: string }>;
  const mammoth: {
    extractRawText(input: { buffer: Buffer }): Promise<{ value: string }>;
  };
  export default mammoth;
}

declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs' {
  export const WorkerMessageHandler: unknown;
}
