import { describe, it, expect, beforeEach } from 'vitest';
import { ModalModel } from './ModalModel';
import { setupMongoTest } from '../../__test__/utils';

describe('ModalModel video', () => {
  setupMongoTest();

  beforeEach(async () => {
    await ModalModel.deleteMany({});
  });

  it('defaults video to null', async () => {
    const modal = await ModalModel.create({ title: 'No video' });
    const stored = await ModalModel.findById(modal._id).lean();
    expect(stored?.video).toBeNull();
  });

  it('round-trips the video urls, filling unset ones with null', async () => {
    const modal = await ModalModel.create({
      title: 'With video',
      video: {
        landscapeUrl: 'https://bucket.s3.us-east-2.amazonaws.com/modals/demo-16x9.mp4',
        landscapePosterUrl: 'https://bucket.s3.us-east-2.amazonaws.com/modals/demo-16x9.png',
      },
    });

    const stored = await ModalModel.findById(modal._id).lean();
    expect(stored?.video).toEqual({
      landscapeUrl: 'https://bucket.s3.us-east-2.amazonaws.com/modals/demo-16x9.mp4',
      landscapePosterUrl: 'https://bucket.s3.us-east-2.amazonaws.com/modals/demo-16x9.png',
      portraitUrl: null,
      portraitPosterUrl: null,
    });
  });
});
