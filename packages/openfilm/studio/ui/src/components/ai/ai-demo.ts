/**
 * The sample rough cut the UI is designed around. A real draft will come from the model with the same shape: what is
 * said, which media carries it, and how long it runs. Kept in one place so the panel's list and the storyboard show
 * the same shots — they are two views of one draft, not two samples.
 */
export interface DemoShot {
  id: string;
  narrationKey: string;
  media: string;
  seconds: number;
  kind: 'page' | 'footage';
}

export const DEMO_SHOTS: readonly DemoShot[] = [
  { id: 's1', narrationKey: 'ai.shot.s1', media: 'page · title.html', seconds: 1.2, kind: 'page' },
  { id: 's2', narrationKey: 'ai.shot.s2', media: 'page · shot-02.html', seconds: 1.4, kind: 'page' },
  { id: 's3', narrationKey: 'ai.shot.s3', media: 'assets/footage.mp4', seconds: 1.4, kind: 'footage' },
];
