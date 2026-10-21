

import path from "node:path";
import { contratosLeerBuzon } from "./src/tools/contratos.js";

async function main(): Promise<void> {
  const directorioBuzon = path.resolve(
    "fixtures",
    "reto-02",
    "buzon",
  );

  const resultado = await contratosLeerBuzon(directorioBuzon);

  console.log(JSON.stringify(JSON.parse(resultado), null, 2));
}

main().catch((error: unknown) => {
  console.error("Error al probar la lectura del buzón:", error);
  process.exitCode = 1;
});
