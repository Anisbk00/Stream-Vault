declare module 'mux.js' {
  namespace mp4 {
    interface TransmuxerOptions {
      remux?: boolean;
      alignToAVC?: boolean;
      keepOriginalTimestamps?: boolean;
    }

    interface TransmuxedSegment {
      initSegment: Uint8Array;
      data: Uint8Array;
      captions?: unknown[];
      metadata?: unknown[];
    }

    class Transmuxer {
      constructor(options?: TransmuxerOptions);
      on(event: 'data', callback: (segment: TransmuxedSegment) => void): this;
      on(event: 'done', callback: () => void): this;
      on(event: 'error', callback: (error: Error) => void): this;
      on(event: string, callback: (...args: unknown[]) => void): this;
      push(data: Uint8Array): void;
      flush(): void;
      removeAllListeners(): this;
      dispose(): void;
    }
  }

  const muxjs: {
    mp4: typeof mp4;
  };

  export default muxjs;
  export { mp4 };
}
