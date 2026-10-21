# Reto Periferia IT — Agente de Registro de Contratos Vigentes

## Ejecutar en modo demostración (sin LLM)
1. Instala dependencias: `npm install`
2. Verifica tipos: `npm run typecheck`
3. Ejecuta: `npm run dev`
4. Abre `http://localhost:3000`.

Si `OPENAI_API_KEY` no está configurada, la interfaz usa el flujo determinista de demostración.

## Activar el agente LLM
El agente usa function calling de la API de OpenAI y las herramientas locales definidas con Zod. La clave se mantiene en el backend; nunca la pongas en el HTML ni en el navegador.

En PowerShell, antes de iniciar el servidor:

```powershell
$env:OPENAI_API_KEY="TU_CLAVE_DE_API"
$env:OPENAI_MODEL="gpt-4.1-mini"
npm.cmd run dev
```

Opcionalmente configura `OPENAI_BASE_URL` si usas un endpoint compatible. `OPENAI_MODEL` tiene por defecto `gpt-4.1-mini`.

La API de OpenAI requiere una clave de API y facturación/crédito independiente de la suscripción de ChatGPT. No subas la clave a Git ni la incluyas en capturas o entregables. Si el proveedor responde con un error de autenticación, permisos, saldo o modelo, revisa la configuración de la cuenta de API.

## Pruebas deterministas
- `npm run demo`: procesa el buzón sin confirmar msg-006.
- `npm run demo:confirmar`: simula confirmación humana explícita de msg-006.

Los archivos generados quedan en `out/`. Los fixtures originales son de solo lectura.
