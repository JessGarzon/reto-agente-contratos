
import { contratosExtraer } from "./src/tools/contratos.js";

async function main() {
  const directorioBuzon = "./fixtures/reto-02/buzon";

  for (let i = 1; i <= 6; i++) {
    const mensajeId = `msg-${String(i).padStart(3, "0")}`;

    console.log(`\n========== ${mensajeId} ==========`);

    const resultado = await contratosExtraer(
      directorioBuzon,
      mensajeId,
    );

    console.log(JSON.stringify(resultado, null, 2));
  }
}

main().catch((error: unknown) => {
  console.error("Error en las pruebas:", error);
  process.exitCode = 1;
});

