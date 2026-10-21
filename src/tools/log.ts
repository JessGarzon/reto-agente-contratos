
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface RegistroHerramienta {
  herramienta: string;
  sessionId: string;
  argumentos: unknown;
  resultado: "ok" | "error";
  inicio: string;
  duracion_ms: number;
  detalle?: string;
}

export async function registrarLlamadaHerramienta(
  directorio: string,
  registro: RegistroHerramienta,
): Promise<void> {
  const ruta = join(directorio, "out", "log.jsonl");

  await mkdir(dirname(ruta), { recursive: true });

  await appendFile(
    ruta,
    JSON.stringify(registro) + "\n",
    "utf-8",
  );
}
