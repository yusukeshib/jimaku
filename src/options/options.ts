import { getApiKey, getOffsetSeconds, setApiKey, setOffsetSeconds } from "../lib/cache";

const input = document.getElementById("apiKey") as HTMLInputElement;
const offsetInput = document.getElementById("offsetSeconds") as HTMLInputElement;
const saveBtn = document.getElementById("save") as HTMLButtonElement;
const status = document.getElementById("status") as HTMLDivElement;

async function load() {
  const [key, offset] = await Promise.all([getApiKey(), getOffsetSeconds()]);
  if (key) input.value = key;
  offsetInput.value = String(offset);
}

saveBtn.addEventListener("click", async () => {
  const key = input.value.trim();
  if (!key) {
    status.style.color = "#b33";
    status.textContent = "キーが空です。";
    return;
  }
  const rawOffset = offsetInput.value.trim();
  const offset = rawOffset === "" ? 0 : Number(rawOffset);
  if (!Number.isFinite(offset)) {
    status.style.color = "#b33";
    status.textContent = "タイミング補正は数値で入力してください。";
    return;
  }
  await Promise.all([setApiKey(key), setOffsetSeconds(offset)]);
  status.style.color = "#0a7a2f";
  status.textContent = "保存しました。";
  setTimeout(() => (status.textContent = ""), 2500);
});

void load();
