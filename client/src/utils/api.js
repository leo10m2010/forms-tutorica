export const getUser = async (email) => {
  if (!email) {
    return null;
  }

  try {
    const response = await fetch(`/api/users/${email}`);
    if (!response.ok) {
      return null;
    }

    return await response.json();
  } catch (error) {
    return null;
  }
};

export const updateUser = async (email, data) => {
  const body = {
    email,
    data,
  };

  try {
    const response = await fetch(`/api/users`, {
      headers: {
        'content-type': 'application/json',
      },
      method: 'PUT',
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      return null;
    }

    return await response.json();
  } catch (error) {
    return null;
  }
};

export const getFormData = async (formId) => {
  const response = await fetch(`/api/forms/${formId}`);
  if (!response.ok) {
    return null;
  }

  const result = await response.json();
  return result?.formData || result;
};

export const deleteFormData = async (formId) => {
  const response = await fetch(`/api/forms/${formId}`, { method: 'DELETE' });

  return await response.json();
};
