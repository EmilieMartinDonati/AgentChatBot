import { model } from "../lib/llm";

async function main() {

  const response = await model.invoke("Say hello in one short sentence.");
  console.log(response.content);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});