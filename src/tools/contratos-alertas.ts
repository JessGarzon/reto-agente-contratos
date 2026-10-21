
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "csv-parse/sync";

interface RegistroContrato {
  id_contrato: string;
  cliente: string;
  fecha_fin: string;
  requiere_poliza: string;
  estado_poliza: string;
  fecha_registro: string;
}

export async function contratosAlertas(
  directorio: string,
  hoy: string,
): Promise<string> {
  try {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(hoy)) {
      return JSON.stringify({
        ok: false,
        error: "La fecha debe tener formato YYYY-MM-DD.",
      });
    }

    const maestro = join(
      directorio,
      "out",
      "sharepoint",
      "maestro-contratos.csv",
    );

    const filas = parse(await readFile(maestro, "utf-8"), {
      columns: true,
      skip_empty_lines: true,
      bom: true,
      trim: true,
    }) as RegistroContrato[];

    const fechaActual = new Date(`${hoy}T00:00:00Z`);
    const fechaLimite = new Date(fechaActual);
    fechaLimite.setUTCDate(fechaLimite.getUTCDate() + 60);

    const alertas: string[] = [
      "# Alertas de contratos",
      "",
      `Fecha de generación: ${hoy}`,
      "",
    ];

    let totalVencimientos = 0;
    let totalPolizas = 0;
    let totalPosterioresAlCorte = 0;

    alertas.push("## 1. Contratos próximos a vencer", "");

    for (const fila of filas) {
      if (!fila.fecha_fin) continue;

      const vencimiento = new Date(`${fila.fecha_fin}T00:00:00Z`);

      if (
        !Number.isNaN(vencimiento.getTime()) &&
        vencimiento >= fechaActual &&
        vencimiento <= fechaLimite
      ) {
        alertas.push(
          `- **${fila.id_contrato}** — ${fila.cliente}: vence el ${fila.fecha_fin}.`,
        );
        totalVencimientos++;
      }
    }

    if (totalVencimientos === 0) {
      alertas.push("- No hay contratos próximos a vencer.");
    }

    alertas.push("", "## 2. Pólizas que requieren atención", "");

    for (const fila of filas) {
      const requiere = ["true", "1", "si", "sí"].includes(
        fila.requiere_poliza.trim().toLowerCase(),
      );

      if (
        requiere &&
        fila.estado_poliza.trim().toLowerCase() !== "vigente"
      ) {
        alertas.push(
          `- **${fila.id_contrato}** — ${fila.cliente}: estado de póliza "${fila.estado_poliza || "sin definir"}".`,
        );
        totalPolizas++;
      }
    }

    if (totalPolizas === 0) {
      alertas.push("- No hay pólizas pendientes de atención.");
    }

    alertas.push(
      "",
      "## 3. Registros posteriores al corte del maestro",
      "",
    );

    for (const fila of filas) {
      if (fila.fecha_registro > "2026-05-30") {
        alertas.push(
          `- **${fila.id_contrato}** — ${fila.cliente}: registrado el ${fila.fecha_registro}.`,
        );
        totalPosterioresAlCorte++;
      }
    }

    if (totalPosterioresAlCorte === 0) {
      alertas.push("- No hay registros posteriores al corte.");
    }

    const out = join(directorio, "out");
    await mkdir(out, { recursive: true });
    await writeFile(
      join(out, "alertas.md"),
      alertas.join("\n") + "\n",
      "utf-8",
    );

    return JSON.stringify({
      ok: true,
      data: {
        archivo: "out/alertas.md",
        vencimientos: totalVencimientos,
        polizas_pendientes: totalPolizas,
        registros_posteriores_al_corte: totalPosterioresAlCorte,
      },
    });
  } catch (error: unknown) {
    const detalle =
      error instanceof Error ? error.message : "Error desconocido";

    return JSON.stringify({
      ok: false,
      error: `No se pudieron generar las alertas: ${detalle}`,
    });
  }
}
