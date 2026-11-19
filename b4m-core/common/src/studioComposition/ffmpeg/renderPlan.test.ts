import { describe, expect, it } from 'vitest';
import { StudioTimelineSchema, type StudioTimelineInput } from '../timeline';
import {
  buildStudioRenderPlan,
  studioCaptionFontKind,
  STUDIO_CAPTION_FONTS,
  escapeFfmpegFilterValue,
  StudioRenderPlanError,
  toFfmpegColor,
  type StudioRenderSource,
} from './renderPlan';

const fileId = (n: number) => n.toString(16).padStart(24, '0');
const VIDEO = fileId(1);
const IMAGE = fileId(2);
const AUDIO = fileId(3);
const SILENT_VIDEO = fileId(4);

const SOURCES = new Map<string, StudioRenderSource>([
  [VIDEO, { localPath: '/work/src-video.mp4', kind: 'video', hasAudio: true }],
  [IMAGE, { localPath: '/work/src-image.png', kind: 'image', hasAudio: false }],
  [AUDIO, { localPath: '/work/src-audio.mp3', kind: 'audio', hasAudio: true }],
  [SILENT_VIDEO, { localPath: '/work/src-silent.mp4', kind: 'video', hasAudio: false }],
]);

const plan = (tracks: StudioTimelineInput['tracks'], overrides: Partial<StudioTimelineInput> = {}) => {
  const timeline = StudioTimelineSchema.parse({
    version: 1,
    durationMs: 10_000,
    fps: 30,
    outputs: [{ id: 'wide', aspectRatio: '16:9', width: 1920, height: 1080 }],
    tracks,
    ...overrides,
  });
  return buildStudioRenderPlan({
    timeline,
    output: timeline.outputs[0],
    sources: SOURCES,
    filterScriptPath: '/work/filtergraph.txt',
    captionTextPath: index => `/work/caption-${index}.txt`,
    outputPath: '/work/out.mp4',
  });
};

const graphOf = (result: ReturnType<typeof plan>) => {
  const script = result.files.find(file => file.path === '/work/filtergraph.txt');
  if (!script) throw new Error('no filter script');
  return script.content;
};

describe('buildStudioRenderPlan', () => {
  it('renders a single trimmed video clip with cover fit over the background', () => {
    const result = plan(
      [
        {
          id: 'v',
          kind: 'video',
          clips: [{ id: 'c', fileId: VIDEO, startMs: 1000, durationMs: 2000, trimStartMs: 500 }],
        },
      ],
      { backgroundColor: '#112233' }
    );
    const graph = graphOf(result);

    expect(result.args.slice(5, 13)).toEqual([
      '-ss',
      '0.5',
      '-t',
      '2',
      '-protocol_whitelist',
      'file',
      '-i',
      '/work/src-video.mp4',
    ]);
    expect(graph).toContain('color=c=0x112233:s=1920x1080:r=30:d=10,format=yuv420p[base]');
    expect(graph).toContain(
      '[0:v]scale=1920:1080:force_original_aspect_ratio=increase:force_divisible_by=2,crop=1920:1080,format=yuva420p,setsar=1,fps=30,trim=duration=2,setpts=PTS-STARTPTS+1/TB[v0]'
    );
    expect(graph).toContain("[base][v0]overlay=x=0:y=0:eof_action=pass:enable='gte(t,0.983333)*lt(t,2.983333)'[o0]");
    expect(graph).toContain('[o0]format=yuv420p[vout]');
    // The video's own audio joins the mix, delayed to its start.
    expect(graph).toContain('[0:a]atrim=duration=2,');
    expect(graph).toContain('adelay=delays=48000S:all=1[a0]');
    expect(graph).toContain('anullsrc=r=48000:cl=stereo,atrim=duration=10[abed]');
    expect(graph).toContain('[abed][a0]amix=inputs=2:duration=first:normalize=0:dropout_transition=0[aout]');
    expect(result.durationSeconds).toBe(10);
  });

  const CROP_9X16 = { x: 0.1, y: 0, width: 0.316406, height: 1 };
  const portraitOutput = { outputs: [{ id: 'tall', aspectRatio: '9:16' as const, width: 1080, height: 1920 }] };
  const croppedTrack = (fit: 'cover' | 'contain'): StudioTimelineInput['tracks'] => [
    {
      id: 'v',
      kind: 'video',
      clips: [{ id: 'c', fileId: VIDEO, startMs: 0, durationMs: 2000, fit, crop: { '9:16': CROP_9X16 } }],
    },
  ];

  it('frames a cover clip on its crop rect for the output aspect ratio', () => {
    const graph = graphOf(plan(croppedTrack('cover'), portraitOutput));
    expect(graph).toContain(
      "[0:v]crop=w='min(0.316406*iw,1*ih*1080/1920)':h='min(1*ih,0.316406*iw*1920/1080)':x='0.1*iw+(0.316406*iw-ow)/2':y='0*ih+(1*ih-oh)/2',scale=1080:1920,format=yuva420p,setsar=1,"
    );
  });

  it('holds an image before cropping it', () => {
    const tracks: StudioTimelineInput['tracks'] = [
      {
        id: 'v',
        kind: 'video',
        clips: [{ id: 'c', fileId: IMAGE, startMs: 0, durationMs: 2000, crop: { '9:16': CROP_9X16 } }],
      },
    ];
    expect(graphOf(plan(tracks, portraitOutput))).toContain(
      "[0:v]tpad=stop_mode=clone:stop_duration=2,crop=w='min(0.316406*iw,1*ih*1080/1920)'"
    );
  });

  it('renders exactly as before when the crop rect is for another size or the clip is contained', () => {
    const uncropped: StudioTimelineInput['tracks'] = [
      { id: 'v', kind: 'video', clips: [{ id: 'c', fileId: VIDEO, startMs: 0, durationMs: 2000 }] },
    ];
    expect(plan(croppedTrack('cover'))).toEqual(plan(uncropped));
    const contained: StudioTimelineInput['tracks'] = [
      { id: 'v', kind: 'video', clips: [{ id: 'c', fileId: VIDEO, startMs: 0, durationMs: 2000, fit: 'contain' }] },
    ];
    expect(plan(croppedTrack('contain'), portraitOutput)).toEqual(plan(contained, portraitOutput));
  });

  it('holds an image with contain fit, transparent padding and an alpha fade, and adds no audio', () => {
    const result = plan([
      {
        id: 'v',
        kind: 'video',
        clips: [
          { id: 'c', fileId: IMAGE, startMs: 0, durationMs: 3000, trimStartMs: 9000, fit: 'contain', fadeInMs: 500 },
        ],
      },
    ]);
    const graph = graphOf(result);

    expect(result.args.slice(5)).toEqual(
      expect.arrayContaining(['-t', '3', '-protocol_whitelist', 'file', '-i', '/work/src-image.png'])
    );
    // -loop is an image2-only option; the image is decoded once and held by tpad instead.
    expect(result.args).not.toContain('-loop');
    expect(result.args).not.toContain('-ignore_loop');
    expect(result.args).not.toContain('-ss');
    expect(graph).toContain('[0:v]tpad=stop_mode=clone:stop_duration=3,scale=1920:1080:');
    expect(graph).toContain('setsar=1,fps=30,trim=duration=3');
    expect(graph).toContain(
      'force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuva420p,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black@0'
    );
    expect(graph).toContain('fade=t=in:st=0:d=0.5:alpha=1');
    expect(graph).toContain('anullsrc=r=48000:cl=stereo,atrim=duration=10[aout]');
    expect(graph).not.toContain('[0:a]');
  });

  it('loops a GIF by its own loop count instead of image2 -loop, and holds its last frame', () => {
    const gif = fileId(5);
    const timeline = StudioTimelineSchema.parse({
      version: 1,
      durationMs: 4000,
      fps: 30,
      outputs: [{ id: 'wide', aspectRatio: '16:9', width: 1920, height: 1080 }],
      tracks: [{ id: 'v', kind: 'video', clips: [{ id: 'c', fileId: gif, startMs: 0, durationMs: 4000 }] }],
    });
    const result = buildStudioRenderPlan({
      timeline,
      output: timeline.outputs[0],
      sources: new Map([[gif, { localPath: '/work/source-0.GIF', kind: 'image', hasAudio: false }]]),
      outputPath: '/work/out.mp4',
      filterScriptPath: '/work/filtergraph.txt',
      captionTextPath: index => `/work/caption-${index}.txt`,
    });

    expect(result.args.slice(5, 13)).toEqual([
      '-ignore_loop',
      '0',
      '-t',
      '4',
      '-protocol_whitelist',
      'file',
      '-i',
      '/work/source-0.GIF',
    ]);
    expect(result.args).not.toContain('-loop');
    expect(result.args).not.toContain('-framerate');
    // A GIF's own frame delays are resampled to the timeline rate.
    expect(graphOf(result)).toContain('[0:v]tpad=stop_mode=clone:stop_duration=4,');
    expect(graphOf(result)).toContain(',fps=30,trim=duration=4');
  });

  it('never draws two back-to-back captions on the same frame', () => {
    const graph = graphOf(
      plan([
        {
          id: 'cap',
          kind: 'captions',
          clips: [
            { id: 'a', startMs: 0, durationMs: 2000, text: 'First' },
            { id: 'b', startMs: 2000, durationMs: 2000, text: 'Second' },
          ],
        },
      ])
    );

    // The frame at t=2 falls only in the second window.
    expect(graph).toContain("enable='gte(t,-0.016667)*lt(t,1.983333)'");
    expect(graph).toContain("enable='gte(t,1.983333)*lt(t,3.983333)'");
    expect(graph).not.toContain('between(');
  });

  it('mixes audio tracks with volume, fades and per-clip delays, skipping a silent video', () => {
    const graph = graphOf(
      plan([
        {
          id: 'm',
          kind: 'music',
          clips: [
            { id: 'a', fileId: AUDIO, startMs: 2500, durationMs: 4000, volume: 0.5, fadeInMs: 1000, fadeOutMs: 2000 },
          ],
        },
        { id: 's', kind: 'sfx', clips: [{ id: 'b', fileId: SILENT_VIDEO, startMs: 0, durationMs: 1000 }] },
        { id: 'vo', kind: 'voice', clips: [{ id: 'c', fileId: VIDEO, startMs: 0, durationMs: 1000 }] },
      ])
    );

    expect(graph).toContain(
      '[0:a]atrim=duration=4,asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo,volume=0.5,afade=t=in:st=0:d=1,afade=t=out:st=2:d=2,adelay=delays=120000S:all=1[a0]'
    );
    expect(graph).toContain('[1:a]');
    expect(graph).toContain('[abed][a0][a1]amix=inputs=3:duration=first:normalize=0');
    // The silent video on the sfx track contributes nothing and is not even an input.
    expect(graph).not.toContain('src-silent');
  });

  it('wraps captions into one drawtext per line, positioned like the preview', () => {
    const result = plan([
      {
        id: 'cap',
        kind: 'captions',
        clips: [
          {
            id: 'k',
            startMs: 1000,
            durationMs: 2000,
            text: 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen\nend',
            style: {
              position: 'top',
              align: 'left',
              backgroundColor: '#000000',
              fontFamily: 'Georgia',
              maxWidthPct: 50,
            },
          },
        ],
      },
    ]);
    const graph = graphOf(result);
    const captionFiles = result.files.filter(file => file.path.startsWith('/work/caption-'));

    // 50% of 1920 minus box padding at a 54px font fits 28 characters per line.
    expect(captionFiles.map(file => file.content)).toEqual([
      'one two three four five six',
      'seven eight nine ten eleven',
      'twelve thirteen fourteen',
      'fifteen sixteen',
      'end',
    ]);
    const drawtexts = graph.split('drawtext=').slice(1);
    expect(drawtexts).toHaveLength(5);
    expect(drawtexts[0]).toContain(`fontfile=${STUDIO_CAPTION_FONTS.serif}`);
    expect(drawtexts[0]).toContain(
      'textfile=/work/caption-0.txt:expansion=none:fontsize=54:fontcolor=0xFFFFFF:x=22:y='
    );
    expect(drawtexts[0]).toContain('box=1:boxcolor=0x000000');
    expect(drawtexts[0]).toContain("enable='gte(t,0.983333)*lt(t,2.983333)'");
  });

  it('centers and bottom-aligns a default caption with a shadow instead of a box', () => {
    const graph = graphOf(
      plan([{ id: 'cap', kind: 'captions', clips: [{ id: 'k', startMs: 0, durationMs: 1000, text: 'Hi' }] }])
    );

    expect(graph).toContain('x=(w-text_w)/2');
    // 1080 - 6% inset - one 1.25 line of a 54px font, centered in its line box.
    expect(graph).toContain('y=954');
    expect(graph).toContain('shadowcolor=black@0.6');
    expect(graph).not.toContain('box=1');
  });

  it('skips a disabled track entirely', () => {
    const result = plan([
      { id: 'v', kind: 'video', enabled: false, clips: [{ id: 'c', fileId: VIDEO, startMs: 0, durationMs: 1000 }] },
      { id: 'cap', kind: 'captions', enabled: false, clips: [{ id: 'k', startMs: 0, durationMs: 1000, text: 'Hi' }] },
    ]);

    expect(result.args).not.toContain('-i');
    expect(graphOf(result)).not.toContain('drawtext');
    expect(graphOf(result)).toContain('anullsrc');
  });

  it('snaps clip edges to frames and clamps clips to the timeline', () => {
    const graph = graphOf(
      plan([{ id: 'v', kind: 'video', clips: [{ id: 'c', fileId: VIDEO, startMs: 1030, durationMs: 5000 }] }], {
        durationMs: 4000,
        fps: 25,
      })
    );

    expect(graph).toContain("enable='gte(t,1.02)*lt(t,3.98)'");
    expect(graph).toContain('trim=duration=2.96');
  });

  it('rounds an odd output edge down to even', () => {
    const result = plan([], { outputs: [{ id: 'odd', aspectRatio: '1:1', width: 1081, height: 1081 }] });
    expect(result.width).toBe(1080);
    expect(graphOf(result)).toContain('s=1080x1080');
  });

  it('refuses a clip whose file was not resolved, and a file on the wrong kind of track', () => {
    expect(() =>
      plan([{ id: 'v', kind: 'video', clips: [{ id: 'c', fileId: fileId(99), startMs: 0, durationMs: 1000 }] }])
    ).toThrow(StudioRenderPlanError);
    expect(() =>
      plan([{ id: 'v', kind: 'video', clips: [{ id: 'c', fileId: AUDIO, startMs: 0, durationMs: 1000 }] }])
    ).toThrow('A video track holds an audio file');
    expect(() =>
      plan([{ id: 'm', kind: 'music', clips: [{ id: 'c', fileId: IMAGE, startMs: 0, durationMs: 1000 }] }])
    ).toThrow('A music track holds an image file');
  });

  it('emits the encoder settings and a filter script instead of an inline graph', () => {
    const { args } = plan([]);
    expect(args).toEqual(expect.arrayContaining(['-/filter_complex', '/work/filtergraph.txt']));
    expect(args).not.toContain('-filter_complex');
    expect(args.join(' ')).toContain(
      '-map [vout] -map [aout] -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -r 30 -c:a aac -b:a 192k'
    );
    expect(args.join(' ')).toContain('-t 10 -movflags +faststart -progress pipe:1 -nostats /work/out.mp4');
  });
});

describe('filter script flag', () => {
  it('uses -filter_complex_script before ffmpeg 7', () => {
    const timeline = StudioTimelineSchema.parse({
      version: 1,
      durationMs: 1000,
      fps: 30,
      outputs: [{ id: 'wide', aspectRatio: '16:9', width: 1920, height: 1080 }],
      tracks: [],
    });
    const { args } = buildStudioRenderPlan({
      timeline,
      output: timeline.outputs[0],
      sources: new Map(),
      outputPath: '/work/out.mp4',
      filterScriptPath: '/work/filtergraph.txt',
      captionTextPath: index => `/work/caption-${index}.txt`,
      ffmpegMajorVersion: 5,
    });
    expect(args).toEqual(expect.arrayContaining(['-filter_complex_script', '/work/filtergraph.txt']));
    expect(args).not.toContain('-/filter_complex');
  });
});

describe('escapeFfmpegFilterValue', () => {
  it('escapes for the option parser and then for the graph parser', () => {
    // The worked example from the ffmpeg filtergraph escaping docs.
    expect(escapeFfmpegFilterValue("this is a 'string': may contain one, or more, special characters")).toBe(
      "this is a \\\\\\'string\\\\\\'\\\\: may contain one\\, or more\\, special characters"
    );
    expect(escapeFfmpegFilterValue('/tmp/a[1];b')).toBe('/tmp/a\\[1\\]\\;b');
  });
});

describe('toFfmpegColor', () => {
  it('maps #rrggbb to 0xRRGGBB', () => {
    expect(toFfmpegColor('#a0b1c2')).toBe('0xA0B1C2');
  });

  it('refuses anything else', () => {
    expect(() => toFfmpegColor('red:x=1')).toThrow(StudioRenderPlanError);
  });
});

describe('studioCaptionFontKind', () => {
  it.each([
    [undefined, 'sans'],
    ['Inter', 'sans'],
    ['DejaVu Sans', 'sans'],
    ['Georgia', 'serif'],
    ['serif', 'serif'],
    ['Times New Roman, serif', 'serif'],
    ['Courier New', 'mono'],
    ['ui-monospace', 'mono'],
  ])('%s -> %s', (family, kind) => {
    expect(studioCaptionFontKind(family)).toBe(kind);
  });
});
