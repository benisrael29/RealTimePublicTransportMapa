declare module 'adm-zip' {
  export default class AdmZip {
    constructor(input?: unknown);
    getEntry(entryName: string): { getData(): Buffer } | null;
  }
}

