export type SourceDoc = { title: string; content: string; url?: string };
export type Citation = { docIndex: number; citedText: string };
export type AnswerBlock = { text: string; citations: Citation[] };
export type AnswerResult = {
  question: string;
  sources: SourceDoc[];
  blocks: AnswerBlock[];
};
