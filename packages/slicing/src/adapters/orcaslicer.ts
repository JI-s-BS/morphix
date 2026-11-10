// OrcaSlicer adapter: plain G-code, FlashForge .gx (via Morphix) and Bambu .gcode.3mf.
// Shares its command line with Bambu Studio (see orcafamily.ts).
import { orcaFamilyAdapter } from "./orcafamily";

export const orcaslicer = orcaFamilyAdapter("orcaslicer");
