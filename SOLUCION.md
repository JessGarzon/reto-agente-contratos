# Solución — Registro de Contratos Vigentes

## Estado de esta entrega
La versión actual contiene un flujo demostrable de procesamiento local sin necesidad de una clave de proveedor LLM. El objetivo es que los seis mensajes de fixture puedan recorrerse de forma determinista y que los registros se escriban en `out/`, sin modificar `fixtures/`.

## Ejecución
- `npm install`
- `npm run typecheck`
- `npm run dev` o `npm run demo`: procesa la bandeja, registra contratos nuevos/actualizaciones sin revisión pendiente, omite duplicados, rechaza cotizaciones, deja bloqueado el caso con campos de baja confianza y genera alertas.
- `npm run demo:confirmar`: repite la demo simulando la confirmación humana de `msg-006`.

## Componentes
- `src/tools/contratos.ts`: lectura, extracción heurística y validación contra el CSV.
- `src/tools/contratos-registrar.ts`: registro idempotente, copia de trabajo del maestro, archivo del contrato e historial.
- `src/tools/contratos-alertas.ts`: alertas de vencimientos, pólizas y registros posteriores al corte.
- `src/tools/log.ts`: log JSONL de llamadas de herramientas.
- `src/prompts/registro-contratos.md`: reglas del asistente.
- `src/demo.ts`: orquestación reproducible para demostrar los casos.

## Criterios y supuestos
- La extracción usa patrones deterministas como primera etapa; los campos desconocidos permanecen nulos y se solicitan para revisión.
- El maestro en `fixtures/reto-02/maestro-contratos.csv` es de solo lectura. Las modificaciones se hacen sobre `out/sharepoint/maestro-contratos.csv`.
- Una coincidencia por ID con valor y fechas clave iguales se considera duplicada aunque la redacción del objeto tenga diferencias.
- Los otrosí se resuelven contra el contrato relacionado y actualizan los campos explícitamente modificados; la póliza pasa a pendiente de ampliación cuando el plazo se extiende.
- `demo:confirmar` simula una acción humana solo para facilitar una demostración. En una interfaz real, la confirmación debe venir de una acción explícita del usuario autenticado.

## Limitaciones conocidas
Esta entrega es un flujo local de demostración y no integra todavía un proveedor LLM remoto, una interfaz web pública ni un despliegue. Para producción deben añadirse autenticación, autorización, persistencia de sesiones, proveedor LLM configurable y controles de coste.
