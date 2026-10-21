
import { readFile, writeFile, mkdir, copyFile, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

export interface CampoExtraido<T> {
  valor: T | null;
  confianza: number;
}

export interface ContratoExtraido {
  id_contrato: CampoExtraido<string>;
  cliente: CampoExtraido<string>;
  nit_cliente: CampoExtraido<string>;
  pais: CampoExtraido<string>;
  objeto: CampoExtraido<string>;
  valor: CampoExtraido<number>;
  moneda: CampoExtraido<string>;
  fecha_inicio: CampoExtraido<string>;
  fecha_fin: CampoExtraido<string>;
  requiere_poliza: CampoExtraido<boolean>;
  tipo_poliza: CampoExtraido<string>;
  estado_poliza: CampoExtraido<string>;
  comercial: CampoExtraido<string>;
}

interface Registro {
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
}

interface Validacion {
  clasificacion: "nuevo" | "actualizacion" | "duplicado" | "rechazado";
  requiere_revision: string[];
  conflictos: string[];
  motivo: string;
}

const normalizar = (texto: string) =>
  texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]/g, "");

const normalizarNitComparacion = (texto: string): string => {
  const digitos = normalizar(texto);
  return digitos.length === 10 ? digitos.slice(0, 9) : digitos;
};

export async function contratosRegistrar(
  directorio: string,
  mensajeId: string,
  contrato: ContratoExtraido,
  validacion: Validacion,
  confirmado = false,
): Promise<string> {
  try {
    if (validacion.clasificacion === "rechazado") {
      return JSON.stringify({
        ok: false,
        error: `No se puede registrar: ${validacion.motivo}`,
      });
    }

    if (validacion.clasificacion === "duplicado") {
      return JSON.stringify({
        ok: true,
        data: { accion: "sin_cambios", mensaje: "El contrato ya existe." },
      });
    }

    if (validacion.requiere_revision.length > 0 && !confirmado) {
      return JSON.stringify({
        ok: false,
        error: "El contrato requiere revisión humana antes del registro.",
        data: { requiere_revision: validacion.requiere_revision },
      });
    }

    const out = join(directorio, "out");
    const sharepoint = join(out, "sharepoint");
    const maestroOrigen = join(directorio, "fixtures", "reto-02", "maestro-contratos.csv");
    const maestroDestino = join(sharepoint, "maestro-contratos.csv");
    const procesadosRuta = join(out, "procesados.json");
    const historialRuta = join(sharepoint, "historial.jsonl");

    await mkdir(sharepoint, { recursive: true });

    try {
      await access(maestroDestino);
    } catch {
      await copyFile(maestroOrigen, maestroDestino);
    }

    let filas = parse(await readFile(maestroDestino, "utf-8"), {
      columns: true,
      skip_empty_lines: true,
      bom: true,
      trim: true,
    }) as Registro[];

    const valor = <T>(campo: CampoExtraido<T>): T | null => campo.valor;

    const id = valor(contrato.id_contrato);
    const cliente = valor(contrato.cliente);
    const nit = valor(contrato.nit_cliente);
    const objeto = valor(contrato.objeto);

    if (!id || !cliente || !nit || !objeto) {
      return JSON.stringify({
        ok: false,
        error: "Faltan campos obligatorios para registrar el contrato.",
      });
    }

    const indice = filas.findIndex((fila) => {
        if (fila.id_contrato === id) return true;

        const mismoNit =
            normalizarNitComparacion(fila.nit_cliente) ===
            normalizarNitComparacion(nit);

        return (
            mismoNit &&
            normalizar(fila.objeto) === normalizar(objeto)
        );
    });

    const anterior = indice >= 0 ? filas[indice] : undefined;
    const fechaRegistro = new Date().toISOString().slice(0, 10);
    const clienteSlug = normalizar(cliente).slice(0, 60);
    const extension = ".txt";
    const rutaRelativa = `Contratos/${contrato.fecha_inicio.valor?.slice(0, 4) ?? "sin-fecha"}/${clienteSlug}/${id}${extension}`;

    const nuevo: Registro = {
      id_contrato: id,
      cliente,
      nit_cliente: nit,
      pais: valor(contrato.pais) ?? anterior?.pais ?? "",
      objeto,
      valor: String(valor(contrato.valor) ?? anterior?.valor ?? ""),
      moneda: valor(contrato.moneda) ?? anterior?.moneda ?? "",
      fecha_inicio: valor(contrato.fecha_inicio) ?? anterior?.fecha_inicio ?? "",
      fecha_fin: valor(contrato.fecha_fin) ?? anterior?.fecha_fin ?? "",
      requiere_poliza: String(valor(contrato.requiere_poliza) ?? anterior?.requiere_poliza ?? "false"),
      tipo_poliza: valor(contrato.tipo_poliza) ?? anterior?.tipo_poliza ?? "",
      estado_poliza: valor(contrato.estado_poliza) ?? anterior?.estado_poliza ??
        (valor(contrato.requiere_poliza) === true ? "pendiente" : "no_aplica"),
      comercial: valor(contrato.comercial) ?? anterior?.comercial ?? "",
      ruta_sharepoint: anterior?.ruta_sharepoint ?? rutaRelativa,
      fecha_registro: anterior?.fecha_registro ?? fechaRegistro,
      fuente: "buzon",
    };

    if (indice >= 0) filas[indice] = nuevo;
    else filas.push(nuevo);

    await writeFile(
      maestroDestino,
      stringify(filas, { header: true, record_delimiter: "\n" }),
      "utf-8",
    );

    const carpetaContrato = join(sharepoint, ...rutaRelativa.split("/"));
    await mkdir(dirname(carpetaContrato), { recursive: true });
    await writeFile(carpetaContrato, JSON.stringify(nuevo, null, 2), "utf-8");

    let procesados: string[] = [];
    try {
      procesados = JSON.parse(await readFile(procesadosRuta, "utf-8")) as string[];
    } catch {
      procesados = [];
    }
    if (!procesados.includes(mensajeId)) procesados.push(mensajeId);
    await writeFile(procesadosRuta, JSON.stringify(procesados, null, 2), "utf-8");

    await writeFile(
      historialRuta,
      JSON.stringify({
        fecha: fechaRegistro,
        mensaje_id: mensajeId,
        accion: anterior ? "actualizacion" : "nuevo",
        id_contrato: id,
        confirmado,
        campos_modificados: anterior ? validacion.conflictos : [],
      }) + "\n",
      { encoding: "utf-8", flag: "a" },
    );

    return JSON.stringify({
      ok: true,
      data: {
        accion: anterior ? "actualizacion" : "nuevo",
        id_contrato: id,
        ruta_sharepoint: rutaRelativa,
      },
    });
  } catch (error: unknown) {
    const detalle = error instanceof Error ? error.message : "Error desconocido";
    return JSON.stringify({ ok: false, error: `Error al registrar: ${detalle}` });
  }
}
