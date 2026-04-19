import { getApiKey, setApiKey } from "../lib/cache";

const input = document.getElementById("apiKey") as HTMLInputElement;
const saveBtn = document.getElementById("save") as HTMLButtonElement;
const status = document.getElementById("status") as HTMLDivElement;

async function load() {
  const key = await getApiKey();
  if (key) input.value = key;
}

saveBtn.addEventListener("click", async () => {
  const key = input.value.trim();
  if (!key) {
    status.style.color = "#b33";
    status.textContent = "キーが空です。";
    return;
  }
  await setApiKey(key);
  status.style.color = "#0a7a2f";
  status.textContent = "保存しました。";
  setTimeout(() => (status.textContent = ""), 2500);
});

void load();
