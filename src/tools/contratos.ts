
import { z } from "zod";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "csv-parse/sync";

// ============================================================
// 1. MODELOS Y VALIDACIONES
// ============================================================

const CorreoSchema = z.object({
  id: z.string().min(1),
  de: z.string().email(),
  para: z.string().email(),
  asunto: z.string(),
  fecha: z.string().datetime({ offset: true }),
  cuerpo: z.string(),
  adjuntos: z.array(z.string()),
});

type Correo = z.infer<typeof CorreoSchema>;

type ResumenCorreo = {
  id: string;
  de: string;
  asunto: string;
  fecha: string;
  adjuntos: string[];
  tiene_contrato: boolean;
};

type CampoExtraido<T> = {
  valor: T | null;
  confianza: number;
};

export type ContratoExtraido = {
  id_contrato: CampoExtraido<string>;
  cliente: CampoExtraido<string>;
  nit_cliente: CampoExtraido<string>;
  contratista: CampoExtraido<string>;
  nit_contratista: CampoExtraido<string>;
  objeto: CampoExtraido<string>;
  valor: CampoExtraido<number>;
  fecha_inicio: CampoExtraido<string>;
  fecha_fin: CampoExtraido<string>;
  requiere_poliza: CampoExtraido<boolean>;
  estado_poliza: CampoExtraido<string>;
  pais: CampoExtraido<string>;
  moneda: CampoExtraido<string>;
  tipo_poliza: CampoExtraido<string>;
  comercial: CampoExtraido<string>;
};

type TipoDocumento = "contrato" | "otrosi" | "cotizacion" | "no_identificado";

type FilaMaestro = {
  id_contrato: string;
  cliente: string;
  nit_cliente: string;
  pais: string;
  objeto: string;
  valor: string;
  moneda: string;
  fecha_inicio: string;
  fecha_fin: string;
  requiere_poliza: string;
  tipo_poliza: string;
  estado_poliza: string;
  comercial: string;
  ruta_sharepoint: string;
  fecha_registro: string;
  fuente: string;
};

type Clasificacion =
  | "nuevo"
  | "actualizacion"
  | "duplicado"
  | "rechazado";

export type ResultadoValidacion = {
  clasificacion: Clasificacion;
  requiere_revision: string[];
  conflictos: string[];
  motivo: string;
};

// ============================================================
// 2. FUNCIONES AUXILIARES
// ============================================================

function campo<T>(
  valor: T | null,
  confianza: number,
): CampoExtraido<T> {
  return {
    valor,
    confianza: valor === null ? 0 : confianza,
  };
}

function buscar(
  texto: string,
  patron: RegExp,
): string | null {
  return patron.exec(texto)?.[1]?.trim() ?? null;
}

function normalizarTexto(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizarNit(nit: string | null): string {
  return (nit ?? "").replace(/\D/g, "");
}

function crearContratoVacio(): ContratoExtraido {
  return {
    id_contrato: campo<string>(null, 0),
    cliente: campo<string>(null, 0),
    nit_cliente: campo<string>(null, 0),
    contratista: campo<string>(null, 0),
    nit_contratista: campo<string>(null, 0),
    objeto: campo<string>(null, 0),
    valor: campo<number>(null, 0),
    fecha_inicio: campo<string>(null, 0),
    fecha_fin: campo<string>(null, 0),
    requiere_poliza: campo<boolean>(null, 0),
    estado_poliza: campo<string>(null, 0),
    pais: campo<string>(null, 0),
    moneda: campo<string>(null, 0),
    tipo_poliza: campo<string>(null, 0),
    comercial: campo<string>(null, 0),
  };
}

function esAdjuntoContractual(nombre: string): boolean {
  const archivo = path.basename(nombre).toLowerCase();

  return (
    archivo === "contrato.txt" ||
    archivo === "otrosi.txt"
  );
}

function identificarTipoDocumento(
  adjuntos: string[],
): TipoDocumento {
  const nombres = adjuntos.map((nombre) =>
    path.basename(nombre).toLowerCase(),
  );

  if (nombres.includes("otrosi.txt")) {
    return "otrosi";
  }

  if (nombres.includes("contrato.txt")) {
    return "contrato";
  }

  if (nombres.includes("cotizacion.txt")) {
    return "cotizacion";
  }

  return "no_identificado";
}

function extraerFecha(
  texto: string,
  patron: RegExp,
): string | null {
  const coincidencia = patron.exec(texto);

  if (!coincidencia) {
    return null;
  }

  const dia = Number(coincidencia[1]);
  const mesTexto = coincidencia[2]
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  const anio = Number(coincidencia[3]);

  const meses: Record<string, string> = {
    enero: "01",
    febrero: "02",
    marzo: "03",
    abril: "04",
    mayo: "05",
    junio: "06",
    julio: "07",
    agosto: "08",
    septiembre: "09",
    setiembre: "09",
    octubre: "10",
    noviembre: "11",
    diciembre: "12",
  };

  const mes = meses[mesTexto];

  if (
    !mes ||
    anio < 1900 ||
    anio > 2200 ||
    dia < 1 ||
    dia > new Date(
      Date.UTC(anio, Number(mes), 0),
    ).getUTCDate()
  ) {
    return null;
  }

  return `${anio}-${mes}-${String(dia).padStart(2, "0")}`;
}

function extraerFechaNumerica(texto: string): string | null {
  const coincidencia = texto.match(
    /\b(\d{4})-(\d{2})-(\d{2})\b/,
  );

  if (!coincidencia) {
    return null;
  }

  const [, anio, mes, dia] = coincidencia;
  const fecha = new Date(
    Date.UTC(Number(anio), Number(mes) - 1, Number(dia)),
  );

  if (
    fecha.getUTCFullYear() !== Number(anio) ||
    fecha.getUTCMonth() + 1 !== Number(mes) ||
    fecha.getUTCDate() !== Number(dia)
  ) {
    return null;
  }

  return `${anio}-${mes}-${dia}`;
}

// ============================================================
// 3. LECTURA DEL BUZÓN
// ============================================================

export async function contratosLeerBuzon(
  directorioBuzon: string,
): Promise<string> {
  try {
    const carpetas = await readdir(directorioBuzon, {
      withFileTypes: true,
    });

    const mensajes: ResumenCorreo[] = [];

    for (const carpeta of carpetas) {
      if (
        !carpeta.isDirectory() ||
        !/^msg-\d+$/.test(carpeta.name)
      ) {
        continue;
      }

      try {
        const rutaMensaje = path.join(
          directorioBuzon,
          carpeta.name,
        );

        const rutaCorreo = path.join(
          rutaMensaje,
          "correo.json",
        );

        const contenido = await readFile(
          rutaCorreo,
          "utf-8",
        );

        const correo: Correo = CorreoSchema.parse(
          JSON.parse(contenido),
        );

        if (correo.id !== carpeta.name) {
          throw new Error(
            "El ID del correo no coincide con su carpeta.",
          );
        }

        const adjuntos = correo.adjuntos.map(
          (adjunto) => path.basename(adjunto),
        );

        mensajes.push({
          id: correo.id,
          de: correo.de,
          asunto: correo.asunto,
          fecha: correo.fecha,
          adjuntos,
          tiene_contrato: adjuntos.some(
            esAdjuntoContractual,
          ),
        });
      } catch (error: unknown) {
        const detalle =
          error instanceof Error
            ? error.message
            : "Error desconocido";

        console.error(
          `No se pudo leer ${carpeta.name}: ${detalle}`,
        );
      }
    }

    mensajes.sort((a, b) =>
      a.id.localeCompare(b.id),
    );

    return JSON.stringify({
      ok: true,
      data: mensajes,
    });
  } catch (error: unknown) {
    const detalle =
      error instanceof Error
        ? error.message
        : "Error desconocido";

    return JSON.stringify({
      ok: false,
      error: `No se pudo leer el buzón: ${detalle}`,
    });
  }
}

// ============================================================
// 4. EXTRACCIÓN GENERAL DE DATOS
// ============================================================

function extraerContrato(
  texto: string,
): ContratoExtraido {
  const contrato = crearContratoVacio();

  const idContrato = buscar(
    texto,
    /(?:CONTRATO[^.\n]*?\bNo\.?\s*|No\.?\s*)([A-Z]{2,}-\d{4}-\d+)/i,
  );

  // Identifica el primer NIT y nombre de parte en el encabezado.

  const cliente = buscar(
    texto,
    /Entre(?:\s+los\s+suscritos,?)?\s+(.+?)(?=,\s*(?:(?:identificada|identificado)\s+con\s+)?(?:NIT|RUC)\b)/i,
  );

  const nitCliente = buscar(
    texto,
    /Entre(?:\s+los\s+suscritos,?)?\s+.+?,\s*(?:(?:identificada|identificado)\s+con\s+)?(?:NIT|RUC)\s+([\d.-]+)/i,
  );

  const contratista = buscar(
    texto,
    /,\s*y\s+(PERIFERIA IT GROUP S\.A\.S\.)(?=\s*,|\s+identificada|\s+NIT)/i,
  );

  const nitContratista = buscar(
    texto,
    /PERIFERIA IT GROUP S\.A\.S\.,?\s*(?:(?:identificada|identificado)\s+con\s+)?NIT\s+([\d.-]+)/i,
  );

  const objeto = buscar(
    texto,
    /PRIMERA\.\s*OBJETO\.\s*([\s\S]*?)(?=\n\s*SEGUNDA\.)/i,
  );

  const monedaDetectada =
    texto.match(/\b(COP|USD|PEN)\s*\$?\s*([\d.,]+)/i)?.[1]?.toUpperCase() ?? null;
  const valorTexto =
    texto.match(/\b(?:COP|USD|PEN)\s*\$?\s*([\d.,]+)/i)?.[1] ?? null;
  const valor = valorTexto
    ? Number(monedaDetectada === "COP"
        ? valorTexto.replace(/[.,]/g, "")
        : valorTexto.replace(/,/g, ""))
    : null;

  const fechaInicio =
    extraerFecha(
      texto,
      /desde\s+el\s+\w+\s+\((\d{1,2})\)\s+de\s+([a-záéíóú]+)\s+de\s+(\d{4})/i,
    ) ??
    extraerFecha(
      texto,
      /fecha\s+de\s+inicio\s*:\s*(\d{1,2})\s+de\s+([a-záéíóú]+)\s+de\s+(\d{4})/i,
    ) ??
    extraerFechaNumerica(
      buscar(
        texto,
        /fecha\s+de\s+inicio\s*:\s*(\d{4}-\d{2}-\d{2})/i,
      ) ?? "",
    );

  const fechaFin =
    extraerFecha(
      texto,
      /hasta\s+el\s+[\w\s]+?\((\d{1,2})\)\s+de\s+([a-záéíóú]+)\s+de\s+(\d{4})/i,
    ) ??
    extraerFecha(
      texto,
      /fecha\s+(?:de\s+)?(?:terminaci[oó]n|finalizaci[oó]n|fin)\s*:\s*(\d{1,2})\s+de\s+([a-záéíóú]+)\s+de\s+(\d{4})/i,
    );

  const mencionaPoliza =
    /\bp[oó]liza(?:s)?\s+de\s+(?:cumplimiento|calidad|seriedad|responsabilidad)/i.test(
      texto,
    );

  const mencionaNoRequerida =
    /no\s+(?:se\s+)?requiere\s+p[oó]liza|sin\s+requerimiento\s+de\s+p[oó]liza/i.test(
      texto,
    );

  const requierePoliza: boolean | null =
    mencionaNoRequerida
      ? false
      : mencionaPoliza
        ? true
        : false;

  contrato.id_contrato = campo(idContrato, 0.99);
  contrato.cliente = campo(cliente, 0.95);
  contrato.nit_cliente = campo(nitCliente, 0.99);
  contrato.contratista = campo(
    contratista,
    0.95,
  );
  contrato.nit_contratista = campo(
    nitContratista,
    0.99,
  );
  contrato.objeto = campo(objeto, 0.95);
  contrato.valor = campo(
    valor !== null && Number.isFinite(valor)
      ? valor
      : null,
    0.99,
  );
  contrato.fecha_inicio = campo(fechaInicio, 0.95);
  contrato.fecha_fin = campo(fechaFin, 0.95);
  contrato.requiere_poliza = campo(
    requierePoliza,
    requierePoliza === null ? 0 : 0.95,
  );
  contrato.estado_poliza = campo(
    requierePoliza === true ? "pendiente" : "no_aplica",
    0.90,
  );
  contrato.moneda = campo(monedaDetectada, monedaDetectada ? 0.98 : 0);
  contrato.pais = campo(
    /\bRUC\b/i.test(texto) && /Quito|Ecuador/i.test(texto) ? "EC" :
    /\bRUC\b/i.test(texto) && /Lima|Perú|Peru/i.test(texto) ? "PE" :
    /Panamá|Panama/i.test(texto) ? "PA" :
    /Honduras/i.test(texto) ? "HN" : "CO",
    0.85,
  );
  const tiposPoliza = [...texto.matchAll(/p[oó]liza de ([a-záéíóú ]+?)(?: por| del| con|,|\.)/gi)]
    .map((m) => normalizarTexto(m[1]).replace(/ /g, "_"));
  contrato.tipo_poliza = campo(
    tiposPoliza.length
      ? [...new Set(tiposPoliza)].join(";")
      : requierePoliza === false ? "no_aplica" : null,
    tiposPoliza.length || requierePoliza === false ? 0.85 : 0,
  );

  return contrato;
}

// ============================================================
// 5. EXTRACCIÓN POR MENSAJE
// ============================================================

export async function contratosExtraer(
  directorioBuzon: string,
  mensajeId: string,
): Promise<string> {
  try {
    if (!/^msg-\d+$/.test(mensajeId)) {
      return JSON.stringify({
        ok: false,
        error: "El identificador del mensaje no es válido.",
      });
    }

    const rutaMensaje = path.join(
      directorioBuzon,
      mensajeId,
    );

    const rutaCorreo = path.join(
      rutaMensaje,
      "correo.json",
    );

    const contenidoCorreo = await readFile(
      rutaCorreo,
      "utf-8",
    );

    const correo: Correo = CorreoSchema.parse(
      JSON.parse(contenidoCorreo),
    );

    if (correo.id !== mensajeId) {
      return JSON.stringify({
        ok: false,
        error: "El ID del correo no coincide con la carpeta.",
      });
    }

    const tipoDocumento = identificarTipoDocumento(
      correo.adjuntos,
    );

    if (tipoDocumento === "cotizacion") {
      return JSON.stringify({
        ok: true,
        data: {
          mensaje_id: mensajeId,
          tipo_documento: tipoDocumento,
          contrato: null,
          motivo:
            "El adjunto corresponde a una cotización, no a un contrato para registrar.",
        },
      });
    }

    if (tipoDocumento === "no_identificado") {
      return JSON.stringify({
        ok: true,
        data: {
          mensaje_id: mensajeId,
          tipo_documento: tipoDocumento,
          contrato: null,
          motivo:
            "No se identificó un contrato ni un otrosí entre los adjuntos.",
        },
      });
    }

    const nombreAdjunto = correo.adjuntos.find(
      (nombre) =>
        path.basename(nombre).toLowerCase() ===
        (tipoDocumento === "otrosi"
          ? "otrosi.txt"
          : "contrato.txt"),
    );

    if (!nombreAdjunto) {
      return JSON.stringify({
        ok: false,
        error: "No se encontró el adjunto esperado.",
      });
    }

    // Solo se usa el nombre del archivo, no rutas arbitrarias.
    const rutaAdjunto = path.join(
      rutaMensaje,
      path.basename(nombreAdjunto),
    );

    const textoDocumento = await readFile(
      rutaAdjunto,
      "utf-8",
    );

    const contrato = extraerContrato(textoDocumento);

    const referenciaContrato =
      tipoDocumento === "otrosi"
        ? buscar(
            textoDocumento,
            /(?:contrato\s+(?:principal|original|No\.?)|contrato relacionado)[\s\S]{0,80}?\b([A-Z]{2,}-\d{4}-\d+)\b/i,
          ) ??
          buscar(
            textoDocumento,
            /\b(CT-\d{4}-\d{3})\b/i,
          )
        : null;

    const fechaFinModificada =
      tipoDocumento === "otrosi"
        ? extraerFecha(
            textoDocumento,
            /se extiende hasta el\s+[^.(\n]*\s*\((\d{1,2})\)\s+de\s+([a-záéíóú]+)\s+de\s+(\d{4})/i,
          )
        : null;

    return JSON.stringify({
      ok: true,
      data: {
        mensaje_id: mensajeId,
        tipo_documento: tipoDocumento,
        contrato,
        ...(tipoDocumento === "otrosi"
          ? {
              otrosi: {
                id_contrato_relacionado:
                  referenciaContrato,
                fecha_fin_modificada:
                  fechaFinModificada,
              },
            }
          : {}),
      },
    });
  } catch (error: unknown) {
    const detalle =
      error instanceof Error
        ? error.message
        : "Error desconocido";

    return JSON.stringify({
      ok: false,
      error: `No se pudo extraer el documento de ${mensajeId}: ${detalle}`,
    });
  }
}

// ============================================================
// 6. VALIDACIÓN CONTRA EL MAESTRO CSV
// ============================================================

function similitudTexto(
  a: string,
  b: string,
): number {
  const textoA = normalizarTexto(a);
  const textoB = normalizarTexto(b);

  if (textoA === textoB) return 1;
  if (!textoA || !textoB) return 0;

  const filaInicial = Array.from(
    { length: textoB.length + 1 },
    (_, i) => i,
  );

  let filaAnterior = filaInicial;

  for (let i = 1; i <= textoA.length; i++) {
    const filaActual = [i];

    for (let j = 1; j <= textoB.length; j++) {
      filaActual[j] = Math.min(
        filaActual[j - 1] + 1,
        filaAnterior[j] + 1,
        filaAnterior[j - 1] +
          (textoA[i - 1] === textoB[j - 1] ? 0 : 1),
      );
    }

    filaAnterior = filaActual;
  }

  const distancia = filaAnterior[textoB.length];

  return (
    1 -
    distancia /
      Math.max(textoA.length, textoB.length)
  );
}

function validarEstructuraMinima(
  contrato: ContratoExtraido,
): boolean {
  return Boolean(
    contrato.cliente.valor &&
      contrato.contratista.valor &&
      contrato.objeto.valor,
  );
}

export async function contratosValidar(
  rutaMaestro: string,
  contrato: ContratoExtraido,
  opciones?: {
    tipoDocumento?: TipoDocumento;
    referenciaContrato?: string | null;
    fechaFinModificada?: string | null;
  },
): Promise<string> {
  try {
    const contenido = await readFile(rutaMaestro, "utf-8");
    const filas = parse(contenido, {
      columns: true, skip_empty_lines: true, bom: true, trim: true,
    }) as FilaMaestro[];
    const id = opciones?.referenciaContrato ?? contrato.id_contrato.valor;
    const existente = id ? filas.find((fila) => fila.id_contrato === id) : undefined;

    if (opciones?.tipoDocumento === "otrosi") {
      if (!existente) {
        return JSON.stringify({ ok: true, data: {
          clasificacion: "rechazado", requiere_revision: [], conflictos: [],
          motivo: `No se encontró el contrato relacionado ${id ?? ""} para aplicar el otrosí.`,
        }});
      }
      const conflictos: string[] = [];
      const nuevaFecha = opciones.fechaFinModificada ?? contrato.fecha_fin.valor;
      if (nuevaFecha && nuevaFecha !== existente.fecha_fin) conflictos.push("fecha_fin");
      if (contrato.valor.valor !== null && Number(existente.valor) !== contrato.valor.valor) conflictos.push("valor");
      return JSON.stringify({ ok: true, data: {
        clasificacion: conflictos.length ? "actualizacion" : "duplicado",
        requiere_revision: [], conflictos,
        motivo: conflictos.length
          ? "Otrosí relacionado con un contrato existente; modifica campos registrados."
          : "El otrosí no contiene cambios detectables frente al maestro.",
      }});
    }

    const camposRevisables = [
      "id_contrato", "cliente", "nit_cliente", "contratista",
      "nit_contratista", "objeto", "valor", "fecha_inicio",
      "fecha_fin", "requiere_poliza", "estado_poliza",
    ];
    if (contrato.requiere_poliza.valor === true) {
      camposRevisables.push("tipo_poliza");
    }
    const requiereRevision = Object.entries(contrato)
      .filter(([nombre, dato]) => camposRevisables.includes(nombre) && dato.confianza < 0.8)
      .map(([nombre]) => nombre);

    if (!validarEstructuraMinima(contrato)) {
      return JSON.stringify({ ok: true, data: {
        clasificacion: "rechazado", requiere_revision: requiereRevision, conflictos: [],
        motivo: "No se identificaron las partes y el objeto del contrato.",
      }});
    }

    const nit = contrato.nit_cliente.valor;
    const objeto = contrato.objeto.valor;
    const normalizarNitComparacion = (valor: string | null): string => {
      const digitos = normalizarNit(valor);
      return digitos.length === 10 ? digitos.slice(0, 9) : digitos;
    };
    const porNitYObjeto = nit && objeto ? filas.find((fila) =>
      normalizarNitComparacion(fila.nit_cliente) === normalizarNitComparacion(nit) &&
      similitudTexto(fila.objeto, objeto) >= 0.9) : undefined;
    const filaExistente = existente ?? porNitYObjeto;

    if (!filaExistente) {
      return JSON.stringify({ ok: true, data: {
        clasificacion: "nuevo", requiere_revision: requiereRevision, conflictos: [],
        motivo: "No se encontró un contrato coincidente en el maestro.",
      }});
    }

    const conflictos: string[] = [];
    if (contrato.valor.valor !== null && Number(filaExistente.valor) !== contrato.valor.valor) conflictos.push("valor");
    if (contrato.fecha_inicio.valor !== null && filaExistente.fecha_inicio !== contrato.fecha_inicio.valor) conflictos.push("fecha_inicio");
    if (contrato.fecha_fin.valor !== null && filaExistente.fecha_fin !== contrato.fecha_fin.valor) conflictos.push("fecha_fin");

    const mismosCamposClave =
      contrato.valor.valor !== null &&
      Number(filaExistente.valor) === contrato.valor.valor &&
      contrato.fecha_inicio.valor === filaExistente.fecha_inicio &&
      contrato.fecha_fin.valor === filaExistente.fecha_fin;
    const clasificacion: Clasificacion = conflictos.length > 0
      ? "actualizacion"
      : (existente && mismosCamposClave) ||
        (!existente && similitudTexto(filaExistente.objeto, objeto ?? "") >= 0.9)
        ? "duplicado" : "actualizacion";

    return JSON.stringify({ ok: true, data: {
      clasificacion, requiere_revision: requiereRevision, conflictos,
      motivo: clasificacion === "duplicado"
        ? "El contrato ya existe y no presenta cambios en los campos clave."
        : "Se encontró un registro existente con diferencias que requieren evaluación.",
    }});
  } catch (error: unknown) {
    const detalle = error instanceof Error ? error.message : "Error desconocido";
    return JSON.stringify({ ok: false, error: `No se pudo validar el contrato: ${detalle}` });
  }
}
