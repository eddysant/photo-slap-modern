declare module 'heic-decode' {
    interface DecodedImage {
        width: number;
        height: number;
        /** RGBA pixel data */
        data: ArrayBufferLike;
    }
    function decode(options: { buffer: Buffer | Uint8Array }): Promise<DecodedImage>;
    export default decode;
}
