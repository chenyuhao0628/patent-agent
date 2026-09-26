export type PriorArtState = {
  checkedAt: string;
  noticeSignature: string;
  warning: string;
  items: Array<{
    number: string;
    status: 'pending' | 'downloaded' | 'failed';
    message: string;
    relativePath?: string;
  }>;
};
