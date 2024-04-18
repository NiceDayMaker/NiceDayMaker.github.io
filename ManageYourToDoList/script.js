function addTask() {
    var taskInput = document.getElementById("taskInput");
    var taskList = document.getElementById("taskList");

    if (taskInput.value.trim() === "") {
        alert("할 일을 입력하세요.");
        return;
    }

    
    let today = new Date();
    const id = today.getTime().toString();

    const buttonClickHandler = () => {
        document.getElementById(id).parentElement.remove();
    };

    var taskItem = document.createElement("div");
    taskItem.className = "tile";
    taskItem.innerHTML = "<ul style=\"grid-column: 1 / 2;\"><h2>" + today.toLocaleString() + "</h2><li style=\"word-wrap: break-word;\">" + taskInput.value + "</li></ul>"
        + "<button id=\"" + id + "\" style=\"grid-column: 2 / 3;\">지우기</button>";
    taskList.appendChild(taskItem);

    const button = document.getElementById(id);
    button.onclick = buttonClickHandler;

    taskInput.value = "";
}