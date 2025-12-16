declare module 'adm-zip' {
  export default class AdmZip {
    constructor(input?: any);
    getEntry(entryName: string): { getData(): Buffer } | null;
  }
}

