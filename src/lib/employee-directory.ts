export type EmployeeDirectoryEntry = {
  name: string;
  employeeId: string;
  department: string;
};

export type EmployeeEnrollmentStatus = 'not_enrolled' | 'enrolled' | 'invalid';
export type EmployeeDirectoryFilter = EmployeeEnrollmentStatus | 'all' | 'remaining';

export type EmployeeDirectoryEnrollmentEntry = EmployeeDirectoryEntry & {
  status: EmployeeEnrollmentStatus;
  workerId?: string;
};

export type EmployeeDirectorySummary = {
  total: number;
  enrolled: number;
  remaining: number;
  invalid: number;
};

export type DirectoryWorker = {
  id: string;
  name: string;
  employeeId?: string;
  encodingStatus?: 'valid' | 'missing' | 'invalid';
};

export const employeeDirectory: EmployeeDirectoryEntry[] = [
  { name: 'Alex Gonzalez', employeeId: 'F-2', department: 'Area Manager' },
  { name: 'Amanda Bonapace', employeeId: 'S-1', department: 'Sales' },
  { name: 'Angel Centeno Bastardo', employeeId: 'F-29', department: 'Area Manager' },
  { name: 'Angel Julio Alvaraz', employeeId: 'F-24', department: 'Station 2' },
  { name: 'Antonio Fernandez', employeeId: 'F-43', department: 'Station 6' },
  { name: 'Antonio Mora', employeeId: 'F-3', department: 'Mill' },
  { name: 'Aquiles Jose Gomez Caballero', employeeId: 'F-70', department: 'Station 12' },
  { name: 'Arbenis Yofran Calderas Marrufo', employeeId: 'F-6', department: 'Mill' },
  { name: 'Basilio De Jesus Chario Sangrong', employeeId: 'F-5', department: 'Mill' },
  { name: 'Ben Little', employeeId: 'IT-1', department: 'IT' },
  { name: 'Brandi Lowe', employeeId: 'EHS-1', department: 'EHS' },
  { name: 'Bryan Bustos Mauricio Contreras Suarez', employeeId: 'F-71', department: 'Station 12' },
  { name: 'Byrdie Ambercrombie', employeeId: 'S-5', department: 'Sales' },
  { name: 'Camilo (Kevin Rojas) Pacheco', employeeId: 'F-88', department: 'Station 14' },
  { name: 'Carlos Diaz Mijares', employeeId: 'F-76', department: 'Station 13' },
  { name: 'Carole Vowel', employeeId: 'S-3', department: 'Sales' },
  { name: 'Cassie Jaufmann', employeeId: 'S-4', department: 'Sales' },
  { name: 'Cleiber Bolano Machado', employeeId: 'F-12', department: 'Floor Table' },
  { name: 'Daniel Colina Chirino', employeeId: 'F-7', department: 'Mill' },
  { name: 'Danny Quintero Jaimes', employeeId: 'F-52', department: 'Station 7' },
  { name: 'Delwin E. Cubilan Chourio', employeeId: 'F-53', department: 'Station 7' },
  { name: 'Denises Andreina Julio Cortez', employeeId: 'F-23', department: 'Station 1' },
  { name: 'Diana Herrera Payarez', employeeId: 'F-72', department: 'Station 12' },
  { name: 'Diana M. Granada', employeeId: 'F-90', department: 'Station 17' },
  { name: 'Dixon Rivas', employeeId: 'F-9', department: 'Ceiling Table' },
  { name: 'Eddie Aulich', employeeId: 'F-19', department: 'Int. Wall Table' },
  { name: 'Edgar Yovanny Camacaro Montilla', employeeId: 'F-89', department: 'Station 17' },
  { name: 'Eduardo Jose Estremor Caraballo', employeeId: 'F-46', department: 'Station 7' },
  { name: 'Ender (Samuel Morales) Torres', employeeId: 'F-40', department: 'Area Manager' },
  { name: 'Enderson Jesus Astudillo Rivero', employeeId: 'F-42', department: 'Station 6' },
  { name: 'Enrique Esparza', employeeId: 'F-18', department: 'Int. Wall Table' },
  { name: 'Frank Munn', employeeId: 'F-86', department: 'Station 14' },
  { name: 'Freddy Arrieta Gonzales', employeeId: 'F-22', department: 'Ext. Wall Table' },
  { name: 'Freddy Arrieta Vergara', employeeId: 'F-44', department: 'Station 6' },
  { name: 'Fredy Camacho Rodriguez', employeeId: 'F-67', department: 'Station 11' },
  { name: 'Genesis Vasquez', employeeId: 'F-75', department: 'Station 13' },
  { name: 'Gilbelys Lozada', employeeId: 'F-59', department: 'Station 9' },
  { name: 'Gleiver Rafael Puente Morales', employeeId: 'F-84', department: 'Station 14' },
  { name: 'Hector Depablos Martinez', employeeId: 'F-11', department: 'Ceiling Table' },
  { name: 'Hector Esparza', employeeId: 'F-38', department: 'Station 4' },
  { name: 'Isaih Romero', employeeId: 'F-26', department: 'Area Manager' },
  { name: 'Jessica(Ery Camargo) Jones', employeeId: 'F-60', department: 'Station 10' },
  { name: 'Joe Roode', employeeId: 'IT-3', department: 'IT' },
  { name: 'Joel Giraud Guzman', employeeId: 'F-50', department: 'Station 7' },
  { name: 'Jon Leder', employeeId: 'F-14', department: 'Area Manager' },
  { name: 'Jose (Jesus) Perez (Barboza)', employeeId: 'F-54', department: 'Station 9' },
  { name: 'Jose Bolano Martinez', employeeId: 'F-61', department: 'Station 10' },
  { name: 'Jose D Garcia', employeeId: 'F-21', department: 'Ext. Wall Table' },
  { name: 'Jose Josef Moina Garcia', employeeId: 'F-55', department: 'Station 9' },
  { name: 'Jose Luis Chavez Valles', employeeId: 'F-66', department: 'Station 11' },
  { name: 'Jose Orobio', employeeId: 'F-20', department: 'Ext. Wall Table' },
  { name: 'Jose Pina Sanchez', employeeId: 'F-4', department: 'Mill' },
  { name: 'Jose Polido Sanjuan', employeeId: 'F-41', department: 'Station 6' },
  { name: 'Jose Yepez', employeeId: 'F-30', department: 'Area Manager' },
  { name: 'Josue Figueroa Paz', employeeId: 'F-73', department: 'Station 12' },
  { name: 'Juaris Arrieta Naravaez', employeeId: 'F-47', department: 'Station 7' },
  { name: 'Katiuska Bolivar Perara', employeeId: 'F-13', department: 'Floor Table' },
  { name: 'Keven Barnes', employeeId: 'F-45', department: 'Area Manager' },
  { name: 'Kevin Lemus Rivas', employeeId: 'F-36', department: 'Station 4' },
  { name: 'Laura Bautista Centeno', employeeId: 'F-15', department: 'Truss Press' },
  { name: 'Laura Garcia', employeeId: 'F-34', department: 'Station 4' },
  { name: 'Layton Chupp', employeeId: 'F-25', department: 'Station 2' },
  { name: 'Leonardo Enrique Hernandez Moreno', employeeId: 'F-31', department: 'Area Manager' },
  { name: 'Leonel Rafael Guete Rojano', employeeId: 'F-68', department: 'Station 11' },
  { name: 'Luis Barboza', employeeId: 'F-39', department: 'Station 4' },
  { name: 'Malachai Little', employeeId: 'IT-2', department: 'IT' },
  { name: 'Miguel Angel Atacho Chavez', employeeId: 'F-93', department: 'Station 17' },
  { name: 'Nicolas Esteban Dominguez Gomez', employeeId: 'F-8', department: 'Ceiling Table' },
  { name: 'Omaira Granada Henao', employeeId: 'F-91', department: 'Station 17' },
  { name: 'Over Espana Noriega', employeeId: 'F-49', department: 'Station 7' },
  { name: 'Paula Rodriguez Jimenez', employeeId: 'F-32', department: 'Area Manager' },
  { name: 'Rodrigo (Diego) Tovar Garcia', employeeId: 'F-77', department: 'Station 13' },
  { name: 'Roger Dekpe Moise', employeeId: 'F-83', department: 'Station 14' },
  { name: 'Sandra Milena Bayorno', employeeId: 'F-10', department: 'Ceiling Table' },
  { name: 'Sean Haver', employeeId: 'F-56', department: 'Station 9' },
  { name: 'Steven Wheeler (D)', employeeId: 'F-1', department: 'Operations' },
  { name: 'Valentina Heredia Rodriguez', employeeId: 'F-33', department: 'Station 4' },
  { name: 'Winder Romero', employeeId: 'F-63', department: 'Station 10' },
  { name: 'Yamal Romero', employeeId: 'F-78', department: 'Station 13' },
  { name: 'Yaniree Mauren Fermin Alana', employeeId: 'F-57', department: 'Station 9' },
  { name: 'Yimi Infante', employeeId: 'F-28', department: 'Area Manager' },
  { name: 'Yoledidis Carrillo Bravo', employeeId: 'F-35', department: 'Station 4' },
  { name: 'Yolima Carolina Estrada Suarez', employeeId: 'F-64', department: 'Station 11' },
  { name: 'Yonny Rodriguez Acosta', employeeId: 'F-80', department: 'Station 14' },
];

export function normalizeDirectoryValue(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function findEmployeeDirectoryById(employeeId?: string) {
  if (!employeeId?.trim()) return undefined;
  const normalizedId = normalizeDirectoryValue(employeeId);
  return employeeDirectory.find((employee) => normalizeDirectoryValue(employee.employeeId) === normalizedId);
}

function editDistance(left: string, right: string) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}

function termMatches(term: string, searchableParts: string[]) {
  if (searchableParts.some((part) => part.includes(term) || part.startsWith(term))) return true;
  if (term.length < 4) return false;
  return searchableParts.some((part) => Math.abs(part.length - term.length) <= 2 && editDistance(part, term) <= 2);
}

export function reconcileEmployeeDirectory(
  workers: DirectoryWorker[],
): { employees: EmployeeDirectoryEnrollmentEntry[]; summary: EmployeeDirectorySummary } {
  const groupWorkers = (keyForWorker: (worker: DirectoryWorker) => string | undefined) => {
    const groups = new Map<string, DirectoryWorker[]>();
    for (const worker of workers) {
      const key = keyForWorker(worker);
      if (!key) continue;
      groups.set(key, [...(groups.get(key) || []), worker]);
    }
    return groups;
  };
  const workersByEmployeeId = groupWorkers((worker) => worker.employeeId?.trim()
    ? normalizeDirectoryValue(worker.employeeId)
    : undefined);
  const workersByName = groupWorkers((worker) => normalizeDirectoryValue(worker.name));
  const reservedWorkerIds = new Set<string>();

  // Legacy duplicates predate the uniqueness guard. Never choose an arbitrary
  // worker from an ambiguous identity group for a re-enrollment target.
  for (const group of [...workersByEmployeeId.values(), ...workersByName.values()]) {
    if (group.length > 1) group.forEach((worker) => reservedWorkerIds.add(worker.id));
  }

  const idMatches = employeeDirectory.map((employee) => {
    const matches = workersByEmployeeId.get(normalizeDirectoryValue(employee.employeeId));
    const worker = matches?.length === 1 ? matches[0] : undefined;
    if (worker) reservedWorkerIds.add(worker.id);
    return worker;
  });

  const employees = employeeDirectory.map((employee, index) => {
    const idMatch = idMatches[index];
    const nameMatches = workersByName.get(normalizeDirectoryValue(employee.name));
    const nameMatch = nameMatches?.length === 1 ? nameMatches[0] : undefined;
    const worker = idMatch || (nameMatch && !reservedWorkerIds.has(nameMatch.id) ? nameMatch : undefined);
    if (worker) reservedWorkerIds.add(worker.id);
    const status: EmployeeEnrollmentStatus = worker?.encodingStatus === 'valid'
      ? 'enrolled'
      : worker?.encodingStatus === 'invalid'
        ? 'invalid'
        : 'not_enrolled';
    return { ...employee, status, ...(worker ? { workerId: worker.id } : {}) };
  });

  const enrolled = employees.filter((employee) => employee.status === 'enrolled').length;
  const invalid = employees.filter((employee) => employee.status === 'invalid').length;
  return {
    employees,
    summary: { total: employees.length, enrolled, remaining: employees.length - enrolled, invalid },
  };
}

export function searchEmployeeDirectory(query: string, limit = 8) {
  const normalizedQuery = normalizeDirectoryValue(query);
  if (!normalizedQuery) return [];

  const terms = normalizedQuery.split(/\s+/);

  const ranked = employeeDirectory
    .map((employee, index) => {
      const normalizedName = normalizeDirectoryValue(employee.name);
      const normalizedId = normalizeDirectoryValue(employee.employeeId);
      const normalizedDepartment = normalizeDirectoryValue(employee.department);
      const searchable = `${normalizedName} ${normalizedId} ${normalizedDepartment}`;

      const searchableParts = searchable.split(/\s+/);
      const strictMatch = terms.every((term) => searchableParts.some((part) => part.includes(term)));
      if (!terms.every((term) => termMatches(term, searchableParts))) return null;

      // Number terms also match inside IDs and other departments ("4" is in
      // F-24 and "Station 14"), so an exact department must outrank them.
      let score = 5;
      if (normalizedId === normalizedQuery) score = 0;
      else if (normalizedName === normalizedQuery) score = 1;
      else if (normalizedDepartment === normalizedQuery) score = 2;
      else if (normalizedName.startsWith(normalizedQuery)) score = 3;
      else if (terms.every((term) => normalizedName.split(' ').some((part) => part.startsWith(term)))) score = 4;

      return { employee, index, score, strictMatch };
    })
    .filter((result): result is NonNullable<typeof result> => result !== null);

  const results = ranked.some((result) => result.strictMatch)
    ? ranked.filter((result) => result.strictMatch)
    : ranked;

  return results
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .slice(0, limit)
    .map(({ employee }) => employee);
}

export function filterEmployeeDirectory(
  employees: EmployeeDirectoryEnrollmentEntry[],
  query: string,
  status: EmployeeDirectoryFilter,
  limit = 12,
) {
  const employeesById = new Map(employees.map((employee) => [employee.employeeId, employee]));
  const ordered = query.trim()
    ? searchEmployeeDirectory(query, employeeDirectory.length)
        .map((employee) => employeesById.get(employee.employeeId))
        .filter((employee): employee is EmployeeDirectoryEnrollmentEntry => Boolean(employee))
    : employees;

  return ordered
    .filter((employee) => status === 'all' || (status === 'remaining' ? employee.status !== 'enrolled' : employee.status === status))
    .slice(0, query.trim() ? limit : employeeDirectory.length);
}
