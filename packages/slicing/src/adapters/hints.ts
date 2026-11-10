// One line per slicer telling the user how to install it on their distro / CPU.
// Honest about arm: OrcaSlicer and Bambu Studio publish no official arm64/armv7 Linux build;
// PrusaSlicer is packaged by Debian, Raspberry Pi OS, Ubuntu, Fedora and Arch.
import type { SlicerId } from "./types";

type Family = "debian" | "fedora" | "arch" | "other";

export function distroFamily(distro?: string): Family {
  const d = (distro ?? "").toLowerCase();
  if (/debian|ubuntu|raspbian|raspberry|mint|pop|elementary|kali|zorin|devuan/.test(d)) return "debian";
  if (/fedora|rhel|centos|rocky|alma|nobara/.test(d)) return "fedora";
  if (/arch|manjaro|endeavour|garuda|cachy/.test(d)) return "arch";
  return "other";
}

export function isArm(arch?: string): boolean {
  return /^(arm|aarch64)/i.test(arch ?? process.arch);
}

const HEADLESS = "On a machine without a screen also install xvfb (sudo apt install xvfb): its command-line slicer starts GTK.";

export function hintFor(id: SlicerId, env: { distro?: string; arch?: string } = {}): string {
  const fam = distroFamily(env.distro);
  const arm = isArm(env.arch);
  switch (id) {
    case "prusaslicer":
      if (fam === "debian") return "sudo apt install prusa-slicer (Debian / Ubuntu / Raspberry Pi OS package; works on arm64, armhf and x86_64)";
      if (fam === "fedora") return "sudo dnf install prusa-slicer";
      if (fam === "arch") return "sudo pacman -S prusa-slicer";
      return `Install your distro's prusa-slicer package (Debian / Ubuntu / Raspberry Pi OS: sudo apt install prusa-slicer; Fedora: sudo dnf install prusa-slicer; Arch: sudo pacman -S prusa-slicer)${
        arm ? "" : ", or flatpak install flathub com.prusa3d.PrusaSlicer, or put the AppImage from github.com/prusa3d/PrusaSlicer/releases in ~/Applications (chmod +x)"
      }`;
    case "orcaslicer":
      if (arm) return "OrcaSlicer has no official arm64/armv7 Linux build: use PrusaSlicer on this machine (sudo apt install prusa-slicer), or slice on an x86_64 PC";
      if (fam === "arch") return `yay -S orca-slicer-bin (AUR), or flatpak install flathub io.github.softfever.OrcaSlicer. ${HEADLESS}`;
      return `flatpak install flathub io.github.softfever.OrcaSlicer, or put the AppImage from github.com/SoftFever/OrcaSlicer/releases in ~/Applications (chmod +x). ${HEADLESS}`;
    case "bambustudio":
      if (arm) return "Bambu Studio (and OrcaSlicer) have no official arm64/armv7 Linux build, so Bambu printers can't be sliced on this machine: run Morphix on an x86_64 PC for them";
      if (fam === "arch") return `yay -S bambustudio-bin (AUR), or flatpak install flathub com.bambulab.BambuStudio. ${HEADLESS}`;
      return `flatpak install flathub com.bambulab.BambuStudio, or put the AppImage from github.com/bambulab/BambuStudio/releases in ~/Applications (chmod +x). ${HEADLESS}`;
  }
}
