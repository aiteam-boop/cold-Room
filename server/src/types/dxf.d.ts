// Minimal type declaration for the `dxf` package (no bundled types).
declare module 'dxf' {
  export class Helper {
    constructor(content: string);
    parsed: unknown;
    denormalised: unknown;
    toSVG(): string;
    toPolylines(): { bbox: { min: { x: number; y: number }; max: { x: number; y: number } }; polylines: Array<{ rgb?: number[]; vertices: number[][] }> };
  }
  export function parseString(content: string): unknown;
  export function toSVG(parsed: unknown): string;
  export function toPolylines(parsed: unknown): { bbox: unknown; polylines: Array<{ vertices: number[][] }> };
}
