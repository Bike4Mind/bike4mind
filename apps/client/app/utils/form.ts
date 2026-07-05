export function toFormData<T extends Record<string, any>>(data: T) {
  const formData = new FormData();
  Object.keys(data).forEach(key => formData.append(key, data[key]));
  return formData;
}
