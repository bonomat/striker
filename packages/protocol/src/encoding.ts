export const encodeBase64 = (bytes: Uint8Array) => btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
export const decodeBase64 = (text: string) => Uint8Array.from(atob(text), character => character.charCodeAt(0));
